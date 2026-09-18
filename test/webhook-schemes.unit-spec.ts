/**
 * The webhook lane's pure parts (W4.2c): each vendor's trust and event
 * format from captured payload shapes, the signed address, and the
 * request projection the controller hands the schemes.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  bitrix24Webhook,
  hubspotWebhook,
  kommoWebhook,
  pipedriveWebhook,
  signedWebhook,
  type WebhookRequest,
} from '../src/source-plane/records/webhook-schemes';
import { signAddress, verifyAddress } from '../src/source-plane/records/webhook-address';
import { webhookRequestOf } from '../src/source-plane/records/source-webhook.controller';

const URL = 'https://brain.example.test/v1/source-connections/webhook/abc';

function reqOf(p: Partial<WebhookRequest> & { json?: unknown; form?: string }): WebhookRequest {
  const raw =
    p.rawBody ??
    (p.form !== undefined
      ? Buffer.from(p.form, 'utf8')
      : Buffer.from(JSON.stringify(p.json ?? {}), 'utf8'));
  return {
    method: p.method ?? 'POST',
    url: p.url ?? URL,
    headers: p.headers ?? {},
    rawBody: raw,
    body: p.body ?? (p.form !== undefined ? formBody(p.form) : (p.json ?? {})),
    query: p.query ?? {},
  };
}

/** What express' extended urlencoded parser makes of `a[b][0][c]=1`. */
function formBody(form: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(form)) {
    const keys = k.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) node[key] = v;
      else {
        node[key] = node[key] ?? {};
        node = node[key] as Record<string, unknown>;
      }
    });
  }
  return out;
}

describe('hubspot webhook', () => {
  const secret = 'hs-app-secret';
  const events = [
    { objectId: 41, subscriptionType: 'deal.propertyChange', propertyName: 'dealstage' },
    { objectId: 41, subscriptionType: 'deal.creation' },
    { objectId: 12, subscriptionType: 'contact.deletion' },
    { objectId: 3, subscriptionType: 'company.privacyDeletion' },
    { objectId: 9, subscriptionType: 'ticket.creation' },
    { objectId: 7, subscriptionType: 'conversation.creation' },
  ];
  const signed = (body: string, ts = Date.now(), key = secret) => {
    const sig = createHmac('sha256', key).update(`POST${URL}${body}${ts}`).digest('base64');
    return reqOf({
      rawBody: Buffer.from(body, 'utf8'),
      body: JSON.parse(body),
      headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': String(ts) },
    });
  };

  it('accepts the v3 signature under the app secret or the connection secret; refuses a stale or wrong one', () => {
    const body = JSON.stringify(events);
    expect(hubspotWebhook.verify(signed(body), { secret: 'other', appSecret: secret })).toBe(true);
    expect(hubspotWebhook.verify(signed(body), { secret, appSecret: null })).toBe(true);
    expect(hubspotWebhook.verify(signed(body), { secret: 'other', appSecret: 'nope' })).toBe(false);
    expect(
      hubspotWebhook.verify(signed(body, Date.now() - 6 * 60_000), { secret, appSecret: null }),
    ).toBe(false);
    const tampered = signed(body);
    tampered.rawBody = Buffer.from(body.replace('41', '42'), 'utf8');
    expect(hubspotWebhook.verify(tampered, { secret, appSecret: null })).toBe(false);
    expect(hubspotWebhook.verify(reqOf({ json: events }), { secret, appSecret: null })).toBe(false);
  });

  it('maps objects to entity types and deletions to gone; unknown objects are dropped', () => {
    expect(hubspotWebhook.events(reqOf({ json: events }))).toEqual([
      { entity: 'deal', id: '41', deleted: false },
      { entity: 'deal', id: '41', deleted: false },
      { entity: 'person', id: '12', deleted: true },
      { entity: 'organization', id: '3', deleted: true },
      { entity: 'ticket', id: '9', deleted: false },
    ]);
    expect(hubspotWebhook.events(reqOf({ json: { not: 'an array' } }))).toEqual([]);
  });
});

describe('pipedrive webhook', () => {
  const basic = (user: string, pass: string) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  it('trusts HTTP Basic by the password alone', () => {
    const ok = reqOf({ headers: { authorization: basic('brain', 's3cret-s3cret-s3cret') } });
    expect(pipedriveWebhook.verify(ok, { secret: 's3cret-s3cret-s3cret', appSecret: null })).toBe(
      true,
    );
    expect(pipedriveWebhook.verify(ok, { secret: 'other-other-other', appSecret: null })).toBe(
      false,
    );
    expect(pipedriveWebhook.verify(reqOf({}), { secret: 'x', appSecret: null })).toBe(false);
    expect(
      pipedriveWebhook.verify(reqOf({ headers: { authorization: 'Bearer s3cret' } }), {
        secret: 's3cret',
        appSecret: null,
      }),
    ).toBe(false);
  });
  it('reads v2 meta (entity / entity_id / action) and v1 meta (object / id)', () => {
    expect(
      pipedriveWebhook.events(
        reqOf({
          json: {
            meta: { action: 'change', entity: 'deal', entity_id: 41, version: '2.0' },
            data: {},
          },
        }),
      ),
    ).toEqual([{ entity: 'deal', id: '41', deleted: false }]);
    expect(
      pipedriveWebhook.events(
        reqOf({ json: { meta: { action: 'deleted', object: 'person', id: 12 } } }),
      ),
    ).toEqual([{ entity: 'person', id: '12', deleted: true }]);
    expect(
      pipedriveWebhook.events(
        reqOf({ json: { meta: { action: 'change', entity: 'note', entity_id: 1 } } }),
      ),
    ).toEqual([]);
  });
});

describe('bitrix24 webhook', () => {
  const form =
    'event=ONCRMDEALUPDATE&event_handler_id=5&data%5BFIELDS%5D%5BID%5D=41&ts=1758000000&auth%5Bdomain%5D=acme.bitrix24.ru&auth%5Bapplication_token%5D=app-token-app-token';
  it('trusts the application token in the body', () => {
    expect(
      bitrix24Webhook.verify(reqOf({ form }), { secret: 'app-token-app-token', appSecret: null }),
    ).toBe(true);
    expect(
      bitrix24Webhook.verify(reqOf({ form }), { secret: 'another-token-here', appSecret: null }),
    ).toBe(false);
  });
  it('maps ONCRM<OBJECT><ACTION> to entity + gone', () => {
    expect(bitrix24Webhook.events(reqOf({ form }))).toEqual([
      { entity: 'deal', id: '41', deleted: false },
    ]);
    expect(
      bitrix24Webhook.events(
        reqOf({ form: 'event=ONCRMCONTACTDELETE&data%5BFIELDS%5D%5BID%5D=12' }),
      ),
    ).toEqual([{ entity: 'person', id: '12', deleted: true }]);
    expect(
      bitrix24Webhook.events(reqOf({ form: 'event=ONCRMLEADADD&data%5BFIELDS%5D%5BID%5D=7' })),
    ).toEqual([{ entity: 'lead', id: '7', deleted: false }]);
    expect(
      bitrix24Webhook.events(reqOf({ form: 'event=ONTASKADD&data%5BFIELDS%5D%5BID%5D=7' })),
    ).toEqual([]);
  });
});

describe('kommo webhook', () => {
  const form =
    'leads%5Bupdate%5D%5B0%5D%5Bid%5D=41&leads%5Bupdate%5D%5B0%5D%5Bstatus_id%5D=143&contacts%5Badd%5D%5B0%5D%5Bid%5D=12&contacts%5Badd%5D%5B0%5D%5Btype%5D=contact&contacts%5Bupdate%5D%5B0%5D%5Bid%5D=3&contacts%5Bupdate%5D%5B0%5D%5Btype%5D=company&leads%5Bdelete%5D%5B0%5D%5Bid%5D=40&account%5Bsubdomain%5D=acme';
  it('trusts the token in the URL or a bearer', () => {
    expect(
      kommoWebhook.verify(reqOf({ form, query: { token: 'tok-tok-tok-tok-tok' } }), {
        secret: 'tok-tok-tok-tok-tok',
        appSecret: null,
      }),
    ).toBe(true);
    expect(
      kommoWebhook.verify(
        reqOf({ form, headers: { authorization: 'Bearer tok-tok-tok-tok-tok' } }),
        { secret: 'tok-tok-tok-tok-tok', appSecret: null },
      ),
    ).toBe(true);
    expect(
      kommoWebhook.verify(reqOf({ form, query: { token: 'wrong' } }), {
        secret: 'tok-tok-tok-tok-tok',
        appSecret: null,
      }),
    ).toBe(false);
    expect(
      kommoWebhook.verify(reqOf({ form }), { secret: 'tok-tok-tok-tok-tok', appSecret: null }),
    ).toBe(false);
  });
  it('reads leads / contacts / companies with the contact type telling companies apart', () => {
    expect(kommoWebhook.events(reqOf({ form }))).toEqual([
      { entity: 'deal', id: '41', deleted: false },
      { entity: 'deal', id: '40', deleted: true },
      { entity: 'person', id: '12', deleted: false },
      { entity: 'organization', id: '3', deleted: false },
    ]);
  });
});

describe('signed webhook (custom backends)', () => {
  const secret = 'custom-secret-custom-secret';
  it('accepts the HMAC of the raw body, a bearer, or the URL token', () => {
    const body = JSON.stringify({ events: [{ entity: 'deal', id: 41 }] });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const signed = reqOf({
      rawBody: Buffer.from(body),
      body: JSON.parse(body),
      headers: { 'x-brain-signature': `sha256=${sig}` },
    });
    expect(signedWebhook.verify(signed, { secret, appSecret: null })).toBe(true);
    expect(
      signedWebhook.verify(signed, { secret: 'other-other-other-other', appSecret: null }),
    ).toBe(false);
    expect(
      signedWebhook.verify(reqOf({ headers: { authorization: `Bearer ${secret}` } }), {
        secret,
        appSecret: null,
      }),
    ).toBe(true);
    expect(
      signedWebhook.verify(reqOf({ query: { token: secret } }), { secret, appSecret: null }),
    ).toBe(true);
    expect(signedWebhook.verify(reqOf({}), { secret, appSecret: null })).toBe(false);
  });
  it('reads { events: [...] } or one event; deleted is opt-in', () => {
    expect(
      signedWebhook.events(
        reqOf({
          json: {
            events: [
              { entity: 'deal', id: 41 },
              { entity: 'person', id: '12', deleted: true },
              { id: 3 },
            ],
          },
        }),
      ),
    ).toEqual([
      { entity: 'deal', id: '41', deleted: false },
      { entity: 'person', id: '12', deleted: true },
    ]);
    expect(signedWebhook.events(reqOf({ json: { entity: 'ticket', id: 7 } }))).toEqual([
      { entity: 'ticket', id: '7', deleted: false },
    ]);
  });
});

describe('webhook address', () => {
  const saved = process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = saved;
  });
  it('round-trips and refuses an edited, non-canonical or foreign-key address', () => {
    const a = signAddress('co_acme', 'abc123');
    expect(verifyAddress(a)).toEqual({ companyId: 'co_acme', tail: 'abc123' });
    const decoded = Buffer.from(a, 'base64url').toString('utf8');
    const edited = Buffer.from(decoded.replace('co_acme', 'co_evil'), 'utf8').toString('base64url');
    expect(verifyAddress(edited)).toBeNull();
    expect(verifyAddress(`${a}=`)).toBeNull();
    expect(verifyAddress('')).toBeNull();
    expect(verifyAddress('not base64url at all!')).toBeNull();
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(verifyAddress(a)).toBeNull();
  });
  it('refuses to sign malformed ids', () => {
    expect(() => signAddress('co acme', 'abc')).toThrow(/invalid/);
    expect(() => signAddress('co_acme', 'a.b')).toThrow(/invalid/);
  });
});

describe('webhookRequestOf', () => {
  it('projects headers (lower-cased, first value), the raw body, the query and the full URL', () => {
    const raw = Buffer.from('{"a":1}', 'utf8');
    const req = {
      method: 'POST',
      originalUrl: '/v1/source-connections/webhook/abc?token=t',
      url: '/v1/source-connections/webhook/abc?token=t',
      headers: {
        'X-HubSpot-Signature-v3': 'sig',
        host: 'brain.example.test',
        'x-forwarded-proto': 'https',
        accept: ['a', 'b'],
      },
      query: { token: 't', n: ['x'] },
      body: { a: 1 },
      rawBody: raw,
      protocol: 'http',
    };
    const out = webhookRequestOf(req as never);
    expect(out.url).toBe('https://brain.example.test/v1/source-connections/webhook/abc?token=t');
    expect(out.headers['x-hubspot-signature-v3']).toBe('sig');
    expect(out.headers.accept).toBe('a');
    expect(out.query).toEqual({ token: 't' });
    expect(out.rawBody).toBe(raw);
    expect(out.body).toEqual({ a: 1 });
  });
  it('falls back to the serialised body when no raw bytes were kept', () => {
    const out = webhookRequestOf({
      method: 'POST',
      headers: {},
      query: {},
      body: { a: 1 },
      url: '/x',
    } as never);
    expect(out.rawBody.toString('utf8')).toBe('{"a":1}');
  });
});
