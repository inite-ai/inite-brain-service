import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How each vendor calls back and how the call is trusted
 * (docs/roadmap/crm-sources-2026-09.md § 4.4). A scheme answers two
 * questions about one inbound request — is it the vendor's (`verify`),
 * and which records changed (`events`) — and nothing else: no data from
 * the request ever enters memory, the engine fetches the named records
 * itself. Pure functions over the request, so every vendor's format is
 * unit-tested from a captured payload.
 *
 * Trust, per vendor:
 *   hubspot   — HubSpot's v3 signature: base64(HMAC-SHA256(secret,
 *               method + uri + body + timestamp)) in X-HubSpot-Signature-v3,
 *               the timestamp within five minutes; the secret is the
 *               app's client secret (the deployment's OAuth app, or the
 *               private app's — pasted at setup).
 *   pipedrive — HTTP Basic on the webhook (the password is the secret).
 *   bitrix24  — the outbound webhook's `auth[application_token]`
 *               (pasted at setup) — Bitrix24 signs nothing else.
 *   kommo     — Kommo signs nothing and sets no header: the secret rides
 *               in the URL (`?token=`), which is the vendor's ceiling.
 *   signed    — a custom backend / an automation: HMAC-SHA256 hex of the
 *               raw body in X-Brain-Signature (`sha256=<hex>`), or the
 *               secret as a bearer, or `?token=`.
 * Every comparison is constant-time.
 */

export interface WebhookRequest {
  method: string;
  /** The URL the vendor called, as it reached the brain (HubSpot signs it). */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  rawBody: Buffer;
  /** The parsed body (JSON, or a form as `qs` nests it). */
  body: unknown;
  query: Record<string, string>;
}

export interface WebhookSecrets {
  /** The connection's own secret (generated, or the vendor's token pasted at setup). */
  secret: string;
  /** The deployment's OAuth app secret for the connector's provider, when there is one. */
  appSecret: string | null;
}

export interface WebhookEvent {
  entity: string;
  id: string;
  deleted: boolean;
}

export interface WebhookScheme {
  id: 'hubspot' | 'pipedrive' | 'bitrix24' | 'kommo' | 'signed';
  verify(req: WebhookRequest, secrets: WebhookSecrets): boolean;
  events(req: WebhookRequest): WebhookEvent[];
  /** How the operator registers it, one line each; `{url}` and `{secret}` are filled in. */
  notes: string[];
  /** The secret is the vendor's (pasted at setup), not one the brain generates. */
  vendorSecret?: boolean;
  /** The secret rides in the registered URL (`?token=`). */
  tokenInUrl?: boolean;
}

const HUBSPOT_SKEW_MS = 5 * 60_000;
const HUBSPOT_OBJECTS: Record<string, string> = {
  deal: 'deal',
  contact: 'person',
  company: 'organization',
  ticket: 'ticket',
};

export const hubspotWebhook: WebhookScheme = {
  id: 'hubspot',
  vendorSecret: true,
  notes: [
    'In the HubSpot app (developer account → your app → Webhooks), set the target URL to {url}.',
    'Subscribe to deal / contact / company creation, propertyChange and deletion.',
    "The secret is the app's client secret: leave it empty at setup to use the deployment's HubSpot app, or paste a private app's client secret.",
  ],
  verify(req, secrets) {
    const given = req.headers['x-hubspot-signature-v3'];
    const ts = Number(req.headers['x-hubspot-request-timestamp']);
    if (!given || !Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() - ts) > HUBSPOT_SKEW_MS) return false;
    const base = `${req.method.toUpperCase()}${req.url}${req.rawBody.toString('utf8')}${ts}`;
    const candidates = [secrets.secret, secrets.appSecret].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    return candidates.some((secret) =>
      same(createHmac('sha256', secret).update(base).digest('base64'), given),
    );
  },
  events(req) {
    if (!Array.isArray(req.body)) return [];
    const out: WebhookEvent[] = [];
    for (const raw of req.body) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as { subscriptionType?: unknown; objectId?: unknown };
      const type = typeof e.subscriptionType === 'string' ? e.subscriptionType : '';
      const [object, action] = type.split('.');
      const entity = object ? HUBSPOT_OBJECTS[object] : undefined;
      if (!entity || e.objectId === undefined || e.objectId === null) continue;
      out.push({
        entity,
        id: String(e.objectId),
        deleted: action === 'deletion' || action === 'privacyDeletion',
      });
    }
    return out;
  },
};

const PIPEDRIVE_ENTITIES = new Set(['deal', 'person', 'organization', 'lead', 'activity']);

export const pipedriveWebhook: WebhookScheme = {
  id: 'pipedrive',
  notes: [
    'In Pipedrive (Tools and apps → Webhooks → Create new webhook), set the endpoint URL to {url}.',
    'Event action: *, event object: deal / person / organization.',
    'HTTP Auth: user "brain", password {secret}.',
  ],
  verify(req, secrets) {
    const header = req.headers.authorization ?? '';
    if (!/^basic /i.test(header)) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const i = decoded.indexOf(':');
    const password = i === -1 ? decoded : decoded.slice(i + 1);
    return same(password, secrets.secret);
  },
  events(req) {
    const body = req.body as
      | {
          meta?: {
            action?: unknown;
            entity?: unknown;
            entity_id?: unknown;
            object?: unknown;
            id?: unknown;
          };
        }
      | null
      | undefined;
    const meta = body?.meta;
    if (!meta || typeof meta !== 'object') return [];
    const entity = String(meta.entity ?? meta.object ?? '');
    const id = meta.entity_id ?? meta.id;
    if (!PIPEDRIVE_ENTITIES.has(entity) || id === undefined || id === null) return [];
    const action = String(meta.action ?? '');
    return [{ entity, id: String(id), deleted: action === 'delete' || action === 'deleted' }];
  },
};

const BITRIX24_EVENT = /^ONCRM(DEAL|LEAD|CONTACT|COMPANY)(ADD|UPDATE|DELETE)$/i;
const BITRIX24_ENTITIES: Record<string, string> = {
  DEAL: 'deal',
  LEAD: 'lead',
  CONTACT: 'person',
  COMPANY: 'organization',
};

export const bitrix24Webhook: WebhookScheme = {
  id: 'bitrix24',
  vendorSecret: true,
  notes: [
    'In Bitrix24 (Developer resources → Other → Outbound webhook), set the handler URL to {url}.',
    'Events: onCrmDealAdd / Update / Delete, onCrmLeadAdd / Update / Delete, onCrmContact…, onCrmCompany….',
    'Paste the application token Bitrix24 shows for the outbound webhook as the secret at setup.',
  ],
  verify(req, secrets) {
    const body = req.body as { auth?: { application_token?: unknown } } | null | undefined;
    const token = body?.auth?.application_token;
    return typeof token === 'string' && same(token, secrets.secret);
  },
  events(req) {
    const body = req.body as
      { event?: unknown; data?: { FIELDS?: { ID?: unknown } } } | null | undefined;
    const m = BITRIX24_EVENT.exec(String(body?.event ?? ''));
    const id = body?.data?.FIELDS?.ID;
    if (!m || id === undefined || id === null) return [];
    const entity = BITRIX24_ENTITIES[m[1]!.toUpperCase()];
    if (!entity) return [];
    return [{ entity, id: String(id), deleted: m[2]!.toUpperCase() === 'DELETE' }];
  },
};

/** Kommo / amoCRM post a form: `leads[update][0][id]`, `contacts[add][0][type]=company`, `contacts[delete]…`. */
export const kommoWebhook: WebhookScheme = {
  id: 'kommo',
  tokenInUrl: true,
  notes: [
    'In Kommo (Settings → Integrations → your integration → Webhooks), add {url} — the token is part of it.',
    'Events: leads add / update / delete, contacts add / update / delete, companies add / update / delete.',
  ],
  verify(req, secrets) {
    return tokenVerify(req, secrets.secret);
  },
  events(req) {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object') return [];
    const out: WebhookEvent[] = [];
    for (const [group, entity] of [
      ['leads', 'deal'],
      ['contacts', 'person'],
      ['companies', 'organization'],
    ] as const) {
      const actions = body[group];
      if (!actions || typeof actions !== 'object') continue;
      for (const [action, list] of Object.entries(actions as Record<string, unknown>)) {
        for (const row of rowsOf(list)) {
          const id = (row as { id?: unknown }).id;
          if (id === undefined || id === null) continue;
          const type = (row as { type?: unknown }).type;
          const kind = group === 'contacts' && type === 'company' ? 'organization' : entity;
          out.push({ entity: kind, id: String(id), deleted: action === 'delete' });
        }
      }
    }
    return out;
  },
};

/** A custom backend or an automation: `{ events: [{ entity, id, deleted? }] }` or one such object. */
export const signedWebhook: WebhookScheme = {
  id: 'signed',
  tokenInUrl: true,
  notes: [
    'POST {url} with a JSON body { "events": [{ "entity": "deal", "id": "41", "deleted": false }] } (or one such object).',
    'Authenticate with the token in the URL, or send it as a bearer, or sign the raw body: X-Brain-Signature: sha256=<HMAC-SHA256 hex under the secret>.',
    'Entity names are the ones the connection syncs (its `endpoints` / `entities`).',
  ],
  verify(req, secrets) {
    if (tokenVerify(req, secrets.secret)) return true;
    const sig = req.headers['x-brain-signature'] ?? '';
    const m = /^sha256=([0-9a-f]{64})$/i.exec(sig.trim());
    if (!m) return false;
    const expected = createHmac('sha256', secrets.secret).update(req.rawBody).digest('hex');
    return same(expected.toLowerCase(), m[1]!.toLowerCase());
  },
  events(req) {
    const body = req.body as { events?: unknown } | null | undefined;
    const list = Array.isArray(body?.events) ? body!.events : body ? [body] : [];
    const out: WebhookEvent[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as { entity?: unknown; id?: unknown; deleted?: unknown };
      if (typeof e.entity !== 'string' || !e.entity || e.id === undefined || e.id === null)
        continue;
      out.push({ entity: e.entity, id: String(e.id), deleted: e.deleted === true });
    }
    return out;
  },
};

export const WEBHOOK_SCHEMES: Record<WebhookScheme['id'], WebhookScheme> = {
  hubspot: hubspotWebhook,
  pipedrive: pipedriveWebhook,
  bitrix24: bitrix24Webhook,
  kommo: kommoWebhook,
  signed: signedWebhook,
};

/** `?token=` or `Authorization: Bearer` equal to the secret. */
function tokenVerify(req: WebhookRequest, secret: string): boolean {
  const q = req.query.token;
  if (typeof q === 'string' && q.length > 0 && same(q, secret)) return true;
  const auth = req.headers.authorization ?? '';
  const m = /^bearer (.+)$/i.exec(auth.trim());
  return m !== null && same(m[1]!, secret);
}

function rowsOf(list: unknown): unknown[] {
  if (Array.isArray(list)) return list;
  // qs parses `[0][id]` into an array, but a sparse or high index becomes an object of index keys.
  if (list && typeof list === 'object') return Object.values(list as Record<string, unknown>);
  return [];
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.byteLength === y.byteLength && timingSafeEqual(x, y);
}
