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
import { cloudHttp, type CloudHttp } from './cloud-http';
import { isoOf, scalars } from './records-vendor';

/**
 * `kommo` — leads (Kommo's word for deals), contacts and companies of
 * a Kommo / amoCRM account on the records contract
 * (docs/roadmap/crm-sources-2026-09.md § 4.2.1), through API v4:
 * `filter[updated_at][from]` + `order[updated_at]=asc` for the
 * incremental walk, 250 a page on `page`, `with=contacts` so a lead
 * carries its contacts and its company inline. Pipelines and their
 * statuses, users and loss reasons are read once per run, so a fact
 * reads `deal_stage: Negotiation`, not `142`; the account's currency
 * rides every lead.
 *
 * The credential is a LONG-LIVED TOKEN of a private integration
 * (Settings → Integrations → the integration → "Long-lived token"; a
 * bearer, valid for years) and `config.baseUrl` names the account
 * (`https://<subdomain>.kommo.com` or `https://<subdomain>.amocrm.ru`).
 * OAuth for Kommo — its token endpoint lives on the account's own host
 * and takes JSON — waits for the per-origin provider lane (W4.3).
 */

export interface KommoConfig {
  entities?: string[] | undefined;
  mapping?: RecordMapping | undefined;
  /** `https://<subdomain>.kommo.com` / `https://<subdomain>.amocrm.ru`. */
  baseUrl?: string | undefined;
  allowPrivate?: boolean | undefined;
}

const PAGE_LIMIT = 250;
const USER_PAGES_CAP = 8;
/** Kommo's fixed status ids for the closing stages. */
const STATUS_WON = 142;
const STATUS_LOST = 143;

const PATHS: Record<string, string> = {
  deal: 'leads',
  person: 'contacts',
  organization: 'companies',
};

interface Lookups {
  statuses: Map<number, string>;
  pipelines: Map<number, string>;
  users: Map<number, string>;
  lossReasons: Map<number, string>;
  currency: string | null;
}

interface CustomField {
  field_code?: string | null;
  values?: Array<{ value?: string | number | null }>;
}

interface KommoRow {
  id: number;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  price?: number | null;
  responsible_user_id?: number | null;
  status_id?: number | null;
  pipeline_id?: number | null;
  loss_reason_id?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
  closed_at?: number | null;
  is_deleted?: boolean;
  custom_fields_values?: CustomField[] | null;
  _embedded?: {
    contacts?: Array<{ id: number; is_main?: boolean }>;
    companies?: Array<{ id: number }>;
  };
}

@Injectable()
export class KommoConnector extends RecordsConnector {
  readonly kind = 'kommo';
  override readonly configExample = {
    baseUrl: 'https://acme.kommo.com',
    entities: ['deal', 'person', 'organization'],
  };
  override readonly credentialHint = 'a long-lived token of a private integration (bearer)';
  readonly entities: EntitySpec[] = [
    {
      type: 'deal',
      label: 'Leads (deals)',
      defaultOn: true,
      fields: [
        { key: 'amount', label: 'Sale (price)' },
        { key: 'currency', label: 'Currency (account)' },
        { key: 'status', label: 'Status (open / won / lost)' },
        { key: 'stage', label: 'Stage (status)' },
        { key: 'pipeline', label: 'Pipeline' },
        { key: 'owner', label: 'Responsible user' },
        { key: 'lost_reason', label: 'Loss reason' },
        { key: 'won_at', label: 'Won at' },
        { key: 'lost_at', label: 'Lost at' },
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
        { key: 'owner', label: 'Responsible user' },
        { key: 'created', label: 'Created at' },
      ],
    },
    {
      type: 'organization',
      label: 'Companies',
      defaultOn: true,
      fields: [
        { key: 'website', label: 'Website' },
        { key: 'address', label: 'Address' },
        { key: 'owner', label: 'Responsible user' },
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
        lost_reason: 'lost_reason',
        won_at: 'won_at',
        lost_at: 'lost_at',
      },
      coreType: 'project',
    },
    // E-mail and phone stay in the render, unmapped (PII predicates are scope-gated).
    person: { fields: { job_title: 'job_title', owner: 'owner' }, coreType: 'customer' },
    organization: { fields: { website: 'website', owner: 'owner' }, coreType: 'customer' },
  };

  private readonly lookups = new Map<string, Promise<Lookups>>();

  override enabled(): boolean {
    return sourceKindEnabled('kommo');
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const path = PATHS[entity];
    if (!path) throw new Error(`kommo: unknown entity "${entity}"`);
    const http = httpOf(ctx);
    const base = baseOf(ctx);
    const pageNo = typeof cursor.page === 'number' ? cursor.page : 1;
    const url = new URL(`${base}/api/v4/${path}`);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('page', String(pageNo));
    url.searchParams.set('order[updated_at]', 'asc');
    if (cursor.since)
      url.searchParams.set(
        'filter[updated_at][from]',
        String(Math.floor(Date.parse(cursor.since) / 1000)),
      );
    if (entity === 'deal') url.searchParams.set('with', 'contacts');
    // An empty page answers 204 — no body, the walk is done.
    const page = (await http.getJson(url.toString())) as {
      _embedded?: Record<string, KommoRow[]>;
      _links?: { next?: { href?: string } };
    } | null;
    const rows = page?._embedded?.[path] ?? [];
    const lookups = await this.lookupsOf(ctx, http, base);
    const records = rows
      .map((row) => toEnvelope(entity, row, lookups))
      .filter((r): r is RecordEnvelope => r !== null);
    return { records, next: page?._links?.next?.href ? pageNo + 1 : null };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const path = PATHS[entity];
    if (!path) return null;
    const http = httpOf(ctx);
    const base = baseOf(ctx);
    const url = new URL(`${base}/api/v4/${path}/${encodeURIComponent(id)}`);
    if (entity === 'deal') url.searchParams.set('with', 'contacts');
    let row: KommoRow | null;
    try {
      row = (await http.getJson(url.toString())) as KommoRow | null;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    if (!row) return null;
    return toEnvelope(entity, row, await this.lookupsOf(ctx, http, base));
  }

  override async endRun(ctx: ConnectorCtx): Promise<void> {
    this.lookups.delete(ctx.connection.id);
    await super.endRun(ctx);
  }

  private lookupsOf(ctx: ConnectorCtx, http: CloudHttp, base: string): Promise<Lookups> {
    let pending = this.lookups.get(ctx.connection.id);
    if (!pending) {
      pending = loadLookups(http, base);
      this.lookups.set(ctx.connection.id, pending);
    }
    return pending;
  }
}

async function loadLookups(http: CloudHttp, base: string): Promise<Lookups> {
  const [pipelinesGot, lossGot, accountGot] = await Promise.all([
    http.getJson(`${base}/api/v4/leads/pipelines`) as Promise<{
      _embedded?: {
        pipelines?: Array<{
          id: number;
          name: string;
          _embedded?: { statuses?: Array<{ id: number; name: string }> };
        }>;
      };
    } | null>,
    (
      http.getJson(`${base}/api/v4/leads/loss_reasons`) as Promise<{
        _embedded?: { loss_reasons?: Array<{ id: number; name: string }> };
      } | null>
    ).catch(() => null),
    (http.getJson(`${base}/api/v4/account`) as Promise<{ currency?: string } | null>).catch(
      () => null,
    ),
  ]);
  const statuses = new Map<number, string>();
  const pipelines = new Map<number, string>();
  for (const p of pipelinesGot?._embedded?.pipelines ?? []) {
    pipelines.set(p.id, p.name);
    for (const s of p._embedded?.statuses ?? []) statuses.set(s.id, s.name);
  }
  const lossReasons = new Map<number, string>();
  for (const r of lossGot?._embedded?.loss_reasons ?? []) lossReasons.set(r.id, r.name);
  const users = new Map<number, string>();
  for (let pageNo = 1; pageNo <= USER_PAGES_CAP; pageNo++) {
    const got = (await http.getJson(`${base}/api/v4/users?limit=250&page=${pageNo}`)) as {
      _embedded?: { users?: Array<{ id: number; name?: string; email?: string }> };
      _links?: { next?: { href?: string } };
    } | null;
    for (const u of got?._embedded?.users ?? []) users.set(u.id, u.name || u.email || String(u.id));
    if (!got?._links?.next?.href) break;
  }
  return { statuses, pipelines, users, lossReasons, currency: accountGot?.currency ?? null };
}

/** One v4 row → the envelope: ids resolved to names, the closing stages folded into a status, relations from `_embedded`. */
export function toEnvelope(entity: string, row: KommoRow, l: Lookups): RecordEnvelope | null {
  if (!row || typeof row.id !== 'number' || row.is_deleted) return null;
  const company = row._embedded?.companies?.[0];
  const worksAt = company
    ? [{ kind: 'works_at', targetType: 'organization', targetExternalId: String(company.id) }]
    : [];
  const common = {
    externalId: String(row.id),
    ...(row.updated_at ? { updatedAt: isoOf(row.updated_at) } : {}),
  };
  switch (entity) {
    case 'deal':
      return { entityType: 'deal', ...leadOf(row, l), relations: partiesOf(row), ...common };
    case 'person':
      return { entityType: 'person', ...contactOf(row, l), relations: worksAt, ...common };
    case 'organization':
      return { entityType: 'organization', ...companyOf(row, l), relations: [], ...common };
    default:
      return null;
  }
}

type Named = Pick<RecordEnvelope, 'name' | 'attributes'>;

function leadOf(row: KommoRow, l: Lookups): Named {
  const status =
    row.status_id === STATUS_WON ? 'won' : row.status_id === STATUS_LOST ? 'lost' : 'open';
  const closedAt = row.closed_at ? isoOf(row.closed_at) : undefined;
  return {
    name: row.name || `lead ${row.id}`,
    attributes: scalars({
      amount: row.price ?? undefined,
      currency: l.currency,
      status,
      stage: nameOf(l.statuses, row.status_id),
      pipeline: nameOf(l.pipelines, row.pipeline_id),
      owner: nameOf(l.users, row.responsible_user_id),
      lost_reason: nameOf(l.lossReasons, row.loss_reason_id),
      won_at: status === 'won' ? closedAt : undefined,
      lost_at: status === 'lost' ? closedAt : undefined,
      created: row.created_at ? isoOf(row.created_at) : undefined,
    }),
  };
}

function contactOf(row: KommoRow, l: Lookups): Named {
  return {
    name:
      row.name || `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || `contact ${row.id}`,
    attributes: scalars({
      email: customField(row, 'EMAIL'),
      phone: customField(row, 'PHONE'),
      job_title: customField(row, 'POSITION'),
      owner: nameOf(l.users, row.responsible_user_id),
      created: row.created_at ? isoOf(row.created_at) : undefined,
    }),
  };
}

function companyOf(row: KommoRow, l: Lookups): Named {
  return {
    name: row.name || `company ${row.id}`,
    attributes: scalars({
      website: customField(row, 'WEB'),
      address: customField(row, 'ADDRESS'),
      owner: nameOf(l.users, row.responsible_user_id),
      created: row.created_at ? isoOf(row.created_at) : undefined,
    }),
  };
}

/** A lead's contacts (the main one first-class) and its company. */
function partiesOf(row: KommoRow): NonNullable<RecordEnvelope['relations']> {
  const company = row._embedded?.companies?.[0];
  return [
    ...(row._embedded?.contacts ?? []).map((c) => ({
      kind: c.is_main ? 'primary_contact' : 'contact',
      targetType: 'person',
      targetExternalId: String(c.id),
    })),
    ...(company
      ? [{ kind: 'organization', targetType: 'organization', targetExternalId: String(company.id) }]
      : []),
  ];
}

/** The name for an id, the id itself when the lookup does not know it, nothing for no id. */
function nameOf(table: Map<number, string>, id: number | null | undefined): string | undefined {
  return id != null ? (table.get(id) ?? String(id)) : undefined;
}

/** The first value of the system custom field with this code (EMAIL, PHONE, POSITION, WEB, ADDRESS). */
function customField(row: KommoRow, code: string): string | undefined {
  const f = row.custom_fields_values?.find((c) => c.field_code === code);
  const v = f?.values?.find(
    (x) => x.value !== null && x.value !== undefined && x.value !== '',
  )?.value;
  return v === undefined || v === null ? undefined : String(v);
}

function baseOf(ctx: ConnectorCtx): string {
  const raw = (configOf(ctx) as KommoConfig).baseUrl?.trim();
  if (!raw) throw new Error('kommo: config.baseUrl (https://<subdomain>.kommo.com) is required');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('kommo: config.baseUrl is not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('kommo: config.baseUrl must be http(s)');
  return u.origin;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('kommo: no long-lived token on this connection');
  return cloudHttp({
    token,
    private: (configOf(ctx) as KommoConfig).allowPrivate === true,
    signal: ctx.signal,
  });
}
