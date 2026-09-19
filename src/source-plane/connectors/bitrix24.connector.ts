import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type { ConnectorCtx, RecordEnvelope } from '../connector';
import type { RecordMapping } from '../records/record-mapping';
import {
  RecordsConnector,
  configOf,
  type EntitySpec,
  type ListCursor,
  type ListPage,
} from '../records/records-connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import { bitrix24Webhook } from '../records/webhook-schemes';
import { CloudHttpError, cloudHttp, type CloudHttp } from './cloud-http';
import { isoOf, scalars } from './records-vendor';

/**
 * `bitrix24` — leads, deals, contacts and companies of a Bitrix24
 * portal on the records contract (docs/roadmap/crm-sources-2026-09.md
 * § 4.2.1), through the universal `crm.item.list` / `crm.item.get`
 * methods (one `entityTypeId` per entity), `filter[>updatedTime]` +
 * `order[updatedTime]` for the incremental walk, 50 a page on the
 * `start` offset. Stage / status / source / industry ids are resolved
 * to their names through `crm.status.list` and the deal pipelines
 * (categories) through `crm.category.list`, the responsible user
 * through `user.get` when the webhook has the `user` scope — once per
 * run.
 *
 * Two credentials (W4.2b / W4.3b). A CONNECTED ACCOUNT
 * (`oauth:<grant>`, the `bitrix24` provider — a local or Marketplace
 * application with `crm` + `user` scopes): the grant learned the
 * portal's REST root at the token endpoint (`client_endpoint` →
 * `grant.apiBase`), every method is a POST under `<portal>/rest/` with
 * the access token as the `auth` parameter in the body, and the engine
 * refreshes the token (28-day refresh tokens). Or an INBOUND WEBHOOK
 * URL (`https://<portal>/rest/<user>/<code>/`, made by a portal admin
 * in Developer resources → Other → Inbound webhook, with the `crm`
 * scope and, for owner names, `user`): every method is a POST under
 * it; the code inside the URL is the secret — stored encrypted like
 * any credential and never echoed in an error. A self-hosted portal on
 * the LAN needs the double opt-in (`config.allowPrivate` + the
 * operator's SOURCE_EGRESS_ALLOW_PRIVATE) like every network connector.
 */

export interface Bitrix24Config {
  entities?: string[] | undefined;
  mapping?: RecordMapping | undefined;
  /** The connection's half of the private-egress opt-in (a self-hosted portal on the LAN). */
  allowPrivate?: boolean | undefined;
}

/** `user.get` pages the runtime reads for owner names (50 a page). */
const USER_PAGES_CAP = 20;

const ENTITY_TYPE_ID: Record<string, number> = {
  lead: 1,
  deal: 2,
  person: 3,
  organization: 4,
};

interface Lookups {
  /** `${ENTITY_ID}:${STATUS_ID}` → NAME (DEAL_STAGE, DEAL_STAGE_<category>, STATUS, SOURCE, INDUSTRY, EMPLOYEES, DEAL_TYPE). */
  statuses: Map<string, string>;
  categories: Map<number, string>;
  users: Map<number, string>;
}

interface Multi {
  value?: string;
  valueType?: string;
}

interface Bitrix24Item {
  id: number;
  title?: string | null;
  name?: string | null;
  lastName?: string | null;
  secondName?: string | null;
  opportunity?: number | string | null;
  currencyId?: string | null;
  stageId?: string | null;
  statusId?: string | null;
  categoryId?: number | null;
  assignedById?: number | null;
  contactId?: number | null;
  companyId?: number | null;
  companyTitle?: string | null;
  sourceId?: string | null;
  typeId?: string | null;
  industry?: string | null;
  employees?: string | null;
  revenue?: number | string | null;
  address?: string | null;
  post?: string | null;
  closed?: 'Y' | 'N' | null;
  probability?: number | null;
  begindate?: string | null;
  closedate?: string | null;
  createdTime?: string | null;
  updatedTime?: string | null;
  email?: Multi[] | null;
  phone?: Multi[] | null;
  web?: Multi[] | null;
}

@Injectable()
export class Bitrix24Connector extends RecordsConnector {
  readonly kind = 'bitrix24';
  override readonly configExample = { entities: ['deal', 'person', 'organization'] };
  override readonly credentialHint =
    'a connected Bitrix24 account (oauth:<grant id>), or an inbound webhook URL of the portal (https://<portal>/rest/<user>/<code>/), scope crm (+ user for owner names)';
  override readonly oauth = {
    provider: 'bitrix24' as const,
    scopes: ['crm', 'user'],
    optional: true,
  };
  override readonly webhook = bitrix24Webhook;
  readonly entities: EntitySpec[] = [
    {
      type: 'deal',
      label: 'Deals',
      defaultOn: true,
      fields: [
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'status', label: 'Status (open / won / lost)' },
        { key: 'stage', label: 'Stage' },
        { key: 'pipeline', label: 'Pipeline (category)' },
        { key: 'owner', label: 'Responsible' },
        { key: 'probability', label: 'Probability' },
        { key: 'begin_date', label: 'Begin date' },
        { key: 'close_date', label: 'Close date' },
        { key: 'type', label: 'Deal type' },
        { key: 'source', label: 'Source' },
        { key: 'created', label: 'Created at' },
      ],
    },
    {
      type: 'lead',
      label: 'Leads',
      defaultOn: false,
      fields: [
        { key: 'status', label: 'Status' },
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'source', label: 'Source' },
        { key: 'owner', label: 'Responsible' },
        { key: 'company_title', label: 'Company (as typed)' },
        { key: 'created', label: 'Created at' },
      ],
    },
    {
      type: 'person',
      label: 'Contacts',
      defaultOn: true,
      fields: [
        { key: 'email', label: 'E-mail' },
        { key: 'phone', label: 'Phone' },
        { key: 'job_title', label: 'Position' },
        { key: 'owner', label: 'Responsible' },
        { key: 'source', label: 'Source' },
        { key: 'created', label: 'Created at' },
      ],
    },
    {
      type: 'organization',
      label: 'Companies',
      defaultOn: true,
      fields: [
        { key: 'industry', label: 'Industry' },
        { key: 'employees', label: 'Employees' },
        { key: 'revenue', label: 'Annual revenue' },
        { key: 'currency', label: 'Currency' },
        { key: 'website', label: 'Website' },
        { key: 'address', label: 'Address' },
        { key: 'owner', label: 'Responsible' },
        { key: 'created', label: 'Created at' },
      ],
    },
  ];
  readonly preset: RecordMapping = {
    deal: {
      fields: {
        amount: 'deal_amount',
        currency: 'currency',
        status: 'deal_status',
        stage: 'deal_stage',
        pipeline: 'pipeline',
        owner: 'owner',
        probability: 'probability',
        close_date: 'expected_close',
        source: 'lead_source',
      },
      coreType: 'project',
    },
    // A Bitrix24 lead is a pre-deal: its status is its stage in the lead funnel.
    lead: {
      fields: {
        status: 'deal_stage',
        amount: 'deal_amount',
        currency: 'currency',
        source: 'lead_source',
        owner: 'owner',
      },
      coreType: 'project',
    },
    // E-mail and phone stay in the render, unmapped (PII predicates are scope-gated).
    person: {
      fields: { job_title: 'job_title', owner: 'owner', source: 'lead_source' },
      coreType: 'customer',
    },
    organization: {
      fields: { industry: 'industry', website: 'website', owner: 'owner' },
      coreType: 'customer',
    },
  };

  private readonly lookups = new Map<string, Promise<Lookups>>();

  override enabled(): boolean {
    return sourceKindEnabled('bitrix24');
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const entityTypeId = ENTITY_TYPE_ID[entity];
    if (!entityTypeId) throw new Error(`bitrix24: unknown entity "${entity}"`);
    const api = apiOf(ctx);
    const start = typeof cursor.page === 'number' ? cursor.page : 0;
    const page = (await api.call('crm.item.list', {
      entityTypeId,
      filter: cursor.since ? { '>updatedTime': cursor.since } : {},
      order: { updatedTime: 'ASC' },
      start,
    })) as { result?: { items?: Bitrix24Item[] }; next?: number };
    const lookups = await this.lookupsOf(ctx, api);
    const records = (page.result?.items ?? [])
      .map((row) => toEnvelope(entity, row, lookups))
      .filter((r): r is RecordEnvelope => r !== null);
    return { records, next: typeof page.next === 'number' ? page.next : null };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const entityTypeId = ENTITY_TYPE_ID[entity];
    if (!entityTypeId) return null;
    const api = apiOf(ctx);
    let got: { result?: { item?: Bitrix24Item } };
    try {
      got = (await api.call('crm.item.get', { entityTypeId, id: Number(id) })) as typeof got;
    } catch (e) {
      // A missing item answers 400 NOT_FOUND, not 404.
      if (/NOT_FOUND|not found/i.test((e as Error).message)) return null;
      throw e;
    }
    if (!got.result?.item) return null;
    return toEnvelope(entity, got.result.item, await this.lookupsOf(ctx, api));
  }

  override async endRun(ctx: ConnectorCtx): Promise<void> {
    this.lookups.delete(ctx.connection.id);
    await super.endRun(ctx);
  }

  private lookupsOf(ctx: ConnectorCtx, api: Bitrix24Api): Promise<Lookups> {
    let pending = this.lookups.get(ctx.connection.id);
    if (!pending) {
      pending = loadLookups(api);
      this.lookups.set(ctx.connection.id, pending);
    }
    return pending;
  }
}

/** One REST method call under the webhook, the secret never in an error. */
interface Bitrix24Api {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

async function loadLookups(api: Bitrix24Api): Promise<Lookups> {
  const statuses = new Map<string, string>();
  const [statusList, categoryList] = await Promise.all([
    api.call('crm.status.list', {}) as Promise<{
      result?: Array<{ ENTITY_ID: string; STATUS_ID: string; NAME: string }>;
    }>,
    api.call('crm.category.list', { entityTypeId: 2 }) as Promise<{
      result?: { categories?: Array<{ id: number; name: string }> };
    }>,
  ]);
  for (const s of statusList.result ?? []) statuses.set(`${s.ENTITY_ID}:${s.STATUS_ID}`, s.NAME);
  const categories = new Map<number, string>();
  for (const c of categoryList.result?.categories ?? []) categories.set(Number(c.id), c.name);
  // Owner names want the `user` scope; a webhook without it keeps the ids.
  const users = new Map<number, string>();
  try {
    let start = 0;
    for (let i = 0; i < USER_PAGES_CAP; i++) {
      const got = (await api.call('user.get', { start })) as {
        result?: Array<{ ID: string | number; NAME?: string; LAST_NAME?: string; EMAIL?: string }>;
        next?: number;
      };
      for (const u of got.result ?? []) {
        const name = `${u.NAME ?? ''} ${u.LAST_NAME ?? ''}`.trim() || u.EMAIL || String(u.ID);
        users.set(Number(u.ID), name);
      }
      if (typeof got.next !== 'number') break;
      start = got.next;
    }
  } catch {
    // no `user` scope on the webhook — ids stay ids
  }
  return { statuses, categories, users };
}

/** One `crm.item` → the envelope: names for ids, relations to the contact / company. */
export function toEnvelope(entity: string, row: Bitrix24Item, l: Lookups): RecordEnvelope | null {
  if (!row || typeof row.id !== 'number') return null;
  const common = {
    externalId: String(row.id),
    ...(row.updatedTime ? { updatedAt: isoOf(row.updatedTime) } : {}),
  };
  switch (entity) {
    case 'deal':
      return { entityType: 'deal', ...dealOf(row, l), relations: partiesOf(row), ...common };
    case 'lead':
      return { entityType: 'lead', ...leadOf(row, l), relations: partiesOf(row), ...common };
    case 'person':
      return {
        entityType: 'person',
        ...personOf(row, l),
        relations: row.companyId
          ? [
              {
                kind: 'works_at',
                targetType: 'organization',
                targetExternalId: String(row.companyId),
              },
            ]
          : [],
        ...common,
      };
    case 'organization':
      return { entityType: 'organization', ...organizationOf(row, l), relations: [], ...common };
    default:
      return null;
  }
}

type Named = Pick<RecordEnvelope, 'name' | 'attributes'>;

function dealOf(row: Bitrix24Item, l: Lookups): Named {
  const category = row.categoryId ?? 0;
  const stageEntity = category ? `DEAL_STAGE_${category}` : 'DEAL_STAGE';
  return {
    name: row.title || `deal ${row.id}`,
    attributes: scalars({
      amount: numberOf(row.opportunity),
      currency: row.currencyId,
      status: dealStatus(row),
      stage: statusName(l, stageEntity, row.stageId),
      pipeline: l.categories.get(category),
      owner: ownerOf(l, row),
      probability: row.probability ?? undefined,
      begin_date: dateOf(row.begindate),
      close_date: dateOf(row.closedate),
      type: statusName(l, 'DEAL_TYPE', row.typeId),
      source: statusName(l, 'SOURCE', row.sourceId),
      created: dateOf(row.createdTime),
    }),
  };
}

function leadOf(row: Bitrix24Item, l: Lookups): Named {
  return {
    name: row.title || `lead ${row.id}`,
    attributes: scalars({
      status: statusName(l, 'STATUS', row.statusId),
      amount: numberOf(row.opportunity),
      currency: row.currencyId,
      source: statusName(l, 'SOURCE', row.sourceId),
      owner: ownerOf(l, row),
      company_title: row.companyTitle,
      created: dateOf(row.createdTime),
    }),
  };
}

function personOf(row: Bitrix24Item, l: Lookups): Named {
  return {
    name: `${row.name ?? ''} ${row.lastName ?? ''}`.trim() || `contact ${row.id}`,
    attributes: scalars({
      email: firstOf(row.email),
      phone: firstOf(row.phone),
      job_title: row.post,
      owner: ownerOf(l, row),
      source: statusName(l, 'SOURCE', row.sourceId),
      created: dateOf(row.createdTime),
    }),
  };
}

function organizationOf(row: Bitrix24Item, l: Lookups): Named {
  return {
    name: row.title || `company ${row.id}`,
    attributes: scalars({
      industry: statusName(l, 'INDUSTRY', row.industry),
      employees: statusName(l, 'EMPLOYEES', row.employees),
      revenue: numberOf(row.revenue),
      currency: row.currencyId,
      website: firstOf(row.web),
      address: row.address,
      owner: ownerOf(l, row),
      created: dateOf(row.createdTime),
    }),
  };
}

/** The contact and the company an item points at (deals and leads). */
function partiesOf(row: Bitrix24Item): NonNullable<RecordEnvelope['relations']> {
  return [
    ...(row.contactId
      ? [{ kind: 'primary_contact', targetType: 'person', targetExternalId: String(row.contactId) }]
      : []),
    ...(row.companyId
      ? [
          {
            kind: 'organization',
            targetType: 'organization',
            targetExternalId: String(row.companyId),
          },
        ]
      : []),
  ];
}

/** The status name for an id under a status entity, the id itself when unknown, nothing for no id. */
function statusName(
  l: Lookups,
  entityId: string,
  id: string | null | undefined,
): string | undefined {
  return id ? (l.statuses.get(`${entityId}:${id}`) ?? id) : undefined;
}

function ownerOf(l: Lookups, row: Bitrix24Item): string | undefined {
  return row.assignedById != null ? l.users.get(row.assignedById) : undefined;
}

function dateOf(v: string | null | undefined): string | undefined {
  return v ? isoOf(v) : undefined;
}

/** open / won / lost from the closed flag and the stage id's semantic suffix (`WON` / `LOSE`, `C<n>:WON`). */
function dealStatus(row: Bitrix24Item): string {
  if (row.closed !== 'Y') return 'open';
  return /(?:^|:)WON$/.test(row.stageId ?? '') ? 'won' : 'lost';
}

function firstOf(items: Multi[] | null | undefined): string | undefined {
  return items?.find((i) => typeof i.value === 'string' && i.value.length > 0)?.value;
}

function numberOf(v: number | string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The webhook URL as the method root — `https://<portal>/rest/<user>/<code>/` — validated by shape. */
export function webhookRoot(credential: string | null): string {
  if (!credential) throw new Error('bitrix24: no inbound webhook URL on this connection');
  let u: URL;
  try {
    u = new URL(credential.trim());
  } catch {
    throw new Error('bitrix24: the credential is not an inbound webhook URL');
  }
  if (
    !/^\/rest\/\d+\/[A-Za-z0-9_-]+\/?$/.test(u.pathname) ||
    (u.protocol !== 'https:' && u.protocol !== 'http:')
  ) {
    throw new Error(
      'bitrix24: the credential must be an inbound webhook URL (https://<portal>/rest/<user>/<code>/)',
    );
  }
  return `${u.origin}${u.pathname.replace(/\/$/, '')}/`;
}

/**
 * The method root and the secret that rides every call: for a connected
 * account `<portal>/rest/` + the access token as the `auth` body
 * parameter (the portal from the grant; the dev override's origin when
 * one is in force); for a webhook the URL itself, its code the secret.
 */
export function restRoot(ctx: ConnectorCtx): { root: string; auth: string | null; secret: string } {
  if (ctx.connection.credentialSource === 'grant') {
    const token = ctx.connection.credential;
    if (!token) throw new Error('bitrix24: the connected account handed no token');
    const ep = providerEndpoints('bitrix24');
    const portal = ep.private ? ep.apiBase : ctx.connection.grant?.apiBase;
    if (!portal) throw new Error('bitrix24: the connected account names no portal — reconnect it');
    return { root: `${portal.replace(/\/$/, '')}/rest/`, auth: token, secret: token };
  }
  const root = webhookRoot(ctx.connection.credential);
  return { root, auth: null, secret: root.split('/').filter(Boolean).at(-1) ?? '' };
}

function apiOf(ctx: ConnectorCtx): Bitrix24Api {
  const { root, auth, secret } = restRoot(ctx);
  // A connected account's token rides both ways the portal takes it: as
  // `Authorization: Bearer` and as the `auth` parameter in the body.
  const http: CloudHttp = cloudHttp({
    token: auth ?? '',
    bearer: auth !== null,
    // A self-hosted portal on the LAN (the connection's half of the opt-in), or the dev override on a connected account.
    private:
      (configOf(ctx) as Bitrix24Config).allowPrivate === true ||
      (auth !== null && providerEndpoints('bitrix24').private),
    signal: ctx.signal,
  });
  return {
    async call(method, params) {
      try {
        const got = (await http.postJson(`${root}${method}.json`, {
          ...params,
          ...(auth ? { auth } : {}),
        })) as {
          error?: string;
          error_description?: string;
        } | null;
        if (got && typeof got.error === 'string') {
          throw new Error(
            `${got.error}${got.error_description ? `: ${got.error_description}` : ''}`,
          );
        }
        return got;
      } catch (e) {
        throw redacted(e, { secret, method, grant: auth !== null });
      }
    },
  };
}

/** An error with the secret masked and the method named; 401 reworded for the credential in use. */
function redacted(e: unknown, on: { secret: string; method: string; grant: boolean }): Error {
  const { secret, method, grant } = on;
  const err = e instanceof Error ? e : new Error(String(e));
  if (err instanceof CloudHttpError && err.status === 401) {
    return new Error(
      grant
        ? `bitrix24: the connected account was rejected (401) at ${method} — reconnect it`
        : `bitrix24: the inbound webhook was rejected (401) at ${method} — recreate it in the portal`,
    );
  }
  const message = secret ? err.message.split(secret).join('***') : err.message;
  return new Error(`bitrix24: ${method} — ${message}`);
}
