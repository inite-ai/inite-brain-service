import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type { ConnectorCtx, RecordEnvelope } from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
import type { RecordMapping } from '../records/record-mapping';
import {
  RecordsConnector,
  type EntitySpec,
  type ListCursor,
  type ListPage,
} from '../records/records-connector';
import { cloudHttp, type CloudHttp } from './cloud-http';
import { isoOf, scalars } from './records-vendor';

/**
 * `hubspot` — deals, contacts and companies of a HubSpot account on the
 * records contract (docs/roadmap/crm-sources-2026-09.md § 4.2.1),
 * through the CRM v3 Search API: one query per object, sorted by the
 * object's last-modified property, `hs_lastmodifieddate GTE since` for
 * the incremental walk, 200 a page on the `after` cursor. HubSpot caps
 * one search at 10 000 results; the connector narrows the window at
 * that edge — the next query starts at the last row's modified-at —
 * so a large portal walks in windows, never in a truncated list.
 * Search results carry no associations, so each page is followed by
 * one v4 associations batch read per relation kind (deal → contacts /
 * companies, contact → companies). Owners, deal pipelines (stage
 * labels) and the contact lifecycle stages are read once per run.
 *
 * Runs as a connected account (OAuth; scopes per object) or on a
 * private-app access token — both bearers. The dev override
 * SOURCE_OAUTH_HUBSPOT_BASE_URL reroutes the API to a fake.
 */

export interface HubSpotConfig {
  entities?: string[] | undefined;
  mapping?: RecordMapping | undefined;
}

const PAGE_LIMIT = 200;
/** The Search API refuses `after` at or beyond this — the window narrows instead. */
const SEARCH_WINDOW_CAP = 10_000;
const ASSOCIATION_BATCH = 100;

interface ObjectSpec {
  object: string;
  modified: string;
  properties: string[];
  /** Relation kind → HubSpot object the association batch read targets. */
  associations: Array<{ kind: string; to: string; targetType: string; onlyFirst?: boolean }>;
}

const OBJECTS: Record<string, ObjectSpec> = {
  deal: {
    object: 'deals',
    modified: 'hs_lastmodifieddate',
    properties: [
      'dealname',
      'amount',
      'deal_currency_code',
      'dealstage',
      'pipeline',
      'hubspot_owner_id',
      'closedate',
      'hs_deal_stage_probability',
      'closed_lost_reason',
      'hs_next_step',
      'hs_is_closed_won',
      'hs_is_closed',
      'createdate',
      'hs_lastmodifieddate',
    ],
    associations: [
      { kind: 'contact', to: 'contacts', targetType: 'person' },
      { kind: 'organization', to: 'companies', targetType: 'organization', onlyFirst: true },
    ],
  },
  person: {
    object: 'contacts',
    modified: 'lastmodifieddate',
    properties: [
      'firstname',
      'lastname',
      'email',
      'phone',
      'jobtitle',
      'company',
      'hubspot_owner_id',
      'lifecyclestage',
      'hs_lead_status',
      'createdate',
      'lastmodifieddate',
    ],
    associations: [
      { kind: 'works_at', to: 'companies', targetType: 'organization', onlyFirst: true },
    ],
  },
  organization: {
    object: 'companies',
    modified: 'hs_lastmodifieddate',
    properties: [
      'name',
      'domain',
      'industry',
      'city',
      'country',
      'numberofemployees',
      'annualrevenue',
      'hubspot_owner_id',
      'lifecyclestage',
      'createdate',
      'hs_lastmodifieddate',
    ],
    associations: [],
  },
};

interface Lookups {
  owners: Map<string, string>;
  /** Stage id → label, across every deal pipeline. */
  stages: Map<string, string>;
  pipelines: Map<string, string>;
  lifecycle: Map<string, string>;
}

interface HubSpotRow {
  id: string;
  properties: Record<string, string | null>;
  /** Present on a `get` with `associations=` (never on a search hit). */
  associations?: Record<string, { results?: Array<{ id: string }> }>;
}

/** The page token: HubSpot's `after`, and the window's lower bound once narrowing moved it. */
interface PageToken {
  after: string | null;
  since: string | null;
}

@Injectable()
export class HubSpotConnector extends RecordsConnector {
  readonly kind = 'hubspot';
  override readonly configExample = { entities: ['deal', 'person', 'organization'] };
  override readonly credentialHint =
    'a connected HubSpot account (oauth:<grant id>), or a private-app access token';
  override readonly oauth = {
    provider: 'hubspot' as const,
    scopes: [
      'crm.objects.deals.read',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.objects.owners.read',
    ],
    optional: true,
  };
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
        { key: 'pipeline', label: 'Pipeline' },
        { key: 'owner', label: 'Owner' },
        { key: 'close_date', label: 'Close date' },
        { key: 'probability', label: 'Probability' },
        { key: 'lost_reason', label: 'Closed lost reason' },
        { key: 'next_step', label: 'Next step' },
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
        { key: 'job_title', label: 'Job title' },
        { key: 'company', label: 'Company (as typed)' },
        { key: 'owner', label: 'Owner' },
        { key: 'lifecycle_stage', label: 'Lifecycle stage' },
        { key: 'lead_status', label: 'Lead status' },
        { key: 'created', label: 'Created at' },
      ],
    },
    {
      type: 'organization',
      label: 'Companies',
      defaultOn: true,
      fields: [
        { key: 'domain', label: 'Domain' },
        { key: 'industry', label: 'Industry' },
        { key: 'city', label: 'City' },
        { key: 'country', label: 'Country' },
        { key: 'employees', label: 'Employees' },
        { key: 'revenue', label: 'Annual revenue' },
        { key: 'owner', label: 'Owner' },
        { key: 'lifecycle_stage', label: 'Lifecycle stage' },
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
        close_date: 'expected_close',
        probability: 'probability',
        lost_reason: 'lost_reason',
        next_step: 'next_step',
      },
      coreType: 'project',
    },
    // E-mail and phone stay in the render, unmapped (PII predicates are scope-gated).
    person: {
      fields: { job_title: 'job_title', owner: 'owner', lifecycle_stage: 'lifecycle_stage' },
      coreType: 'customer',
    },
    organization: {
      fields: {
        domain: 'website',
        industry: 'industry',
        owner: 'owner',
        lifecycle_stage: 'lifecycle_stage',
      },
      coreType: 'customer',
    },
  };

  private readonly lookups = new Map<string, Promise<Lookups>>();

  override enabled(): boolean {
    return sourceKindEnabled('hubspot');
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const spec = OBJECTS[entity];
    if (!spec) throw new Error(`hubspot: unknown entity "${entity}"`);
    const http = httpOf(ctx);
    const base = apiBase();
    const token = tokenOf(cursor);
    const page = (await http.postJson(`${base}/crm/v3/objects/${spec.object}/search`, {
      filterGroups: token.since
        ? [
            {
              filters: [
                {
                  propertyName: spec.modified,
                  operator: 'GTE',
                  value: String(Date.parse(token.since)),
                },
              ],
            },
          ]
        : [],
      sorts: [{ propertyName: spec.modified, direction: 'ASCENDING' }],
      properties: spec.properties,
      limit: PAGE_LIMIT,
      ...(token.after ? { after: token.after } : {}),
    })) as { results?: HubSpotRow[]; paging?: { next?: { after?: string } } };
    const rows = page.results ?? [];
    const lookups = await this.lookupsOf(ctx, http, base);
    const assoc = await readAssociations({ http, base, spec, rows });
    const records = rows
      .map((row) =>
        toEnvelope(entity, row, { lookups, assoc: assoc.get(row.id) ?? associationsOf(row) }),
      )
      .filter((r): r is RecordEnvelope => r !== null);
    const after = page.paging?.next?.after ?? null;
    return { records, next: nextToken({ token, after, rows, spec }) };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const spec = OBJECTS[entity];
    if (!spec) return null;
    const http = httpOf(ctx);
    const base = apiBase();
    const url = new URL(`${base}/crm/v3/objects/${spec.object}/${encodeURIComponent(id)}`);
    url.searchParams.set('properties', spec.properties.join(','));
    if (spec.associations.length)
      url.searchParams.set('associations', spec.associations.map((a) => a.to).join(','));
    let row: HubSpotRow | null;
    try {
      row = (await http.getJson(url.toString())) as HubSpotRow | null;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    if (!row) return null;
    const lookups = await this.lookupsOf(ctx, http, base);
    return toEnvelope(entity, row, { lookups, assoc: associationsOf(row) });
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

function tokenOf(cursor: ListCursor): PageToken {
  const p = cursor.page as Partial<PageToken> | null;
  return { after: p?.after ?? null, since: p?.since ?? cursor.since };
}

/**
 * The next page token: HubSpot's `after` while it stays under the cap;
 * at the cap, a fresh query from the last row's modified-at (the rows
 * are sorted by it, so nothing is skipped and the overlap is one
 * millisecond's worth of rows, deduplicated by revision).
 */
function nextToken(p: {
  token: PageToken;
  after: string | null;
  rows: HubSpotRow[];
  spec: ObjectSpec;
}): PageToken | null {
  if (!p.after) return null;
  if (Number(p.after) < SEARCH_WINDOW_CAP) return { after: p.after, since: p.token.since };
  const last = p.rows.at(-1)?.properties[p.spec.modified] ?? null;
  const lastIso = last ? isoOf(last) : null;
  if (!lastIso || lastIso === p.token.since) {
    throw new Error(
      `hubspot: ${p.spec.object} — more than ${SEARCH_WINDOW_CAP} rows share one modified-at; the window cannot narrow`,
    );
  }
  return { after: null, since: lastIso };
}

/** Row id → relation target ids per association kind, through the v4 batch read, in bounded chunks. */
async function readAssociations(p: {
  http: CloudHttp;
  base: string;
  spec: ObjectSpec;
  rows: HubSpotRow[];
}): Promise<Map<string, Record<string, string[]>>> {
  const out = new Map<string, Record<string, string[]>>();
  if (!p.rows.length || !p.spec.associations.length) return out;
  for (const a of p.spec.associations) {
    for (let i = 0; i < p.rows.length; i += ASSOCIATION_BATCH) {
      const chunk = p.rows.slice(i, i + ASSOCIATION_BATCH);
      const got = (await p.http.postJson(
        `${p.base}/crm/v4/associations/${p.spec.object}/${a.to}/batch/read`,
        { inputs: chunk.map((r) => ({ id: r.id })) },
      )) as {
        results?: Array<{ from: { id: string }; to: Array<{ toObjectId: string | number }> }>;
      };
      for (const r of got.results ?? []) {
        const per = out.get(String(r.from.id)) ?? {};
        per[a.to] = r.to.map((t) => String(t.toObjectId));
        out.set(String(r.from.id), per);
      }
    }
  }
  return out;
}

/** Associations as a `get` returns them inline. */
function associationsOf(row: HubSpotRow): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [to, v] of Object.entries(row.associations ?? {})) {
    out[to] = (v.results ?? []).map((r) => String(r.id));
  }
  return out;
}

async function loadLookups(http: CloudHttp, base: string): Promise<Lookups> {
  const owners = new Map<string, string>();
  let after: string | null = null;
  do {
    const url = new URL(`${base}/crm/v3/owners`);
    url.searchParams.set('limit', '500');
    if (after) url.searchParams.set('after', after);
    const got = (await http.getJson(url.toString())) as {
      results?: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>;
      paging?: { next?: { after?: string } };
    };
    for (const o of got.results ?? []) {
      const name = `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || o.email || String(o.id);
      owners.set(String(o.id), name);
    }
    after = got.paging?.next?.after ?? null;
  } while (after);
  const deals = (await http.getJson(`${base}/crm/v3/pipelines/deals`)) as {
    results?: Array<{ id: string; label: string; stages?: Array<{ id: string; label: string }> }>;
  };
  const stages = new Map<string, string>();
  const pipelines = new Map<string, string>();
  for (const p of deals.results ?? []) {
    pipelines.set(String(p.id), p.label);
    for (const s of p.stages ?? []) stages.set(String(s.id), s.label);
  }
  // Lifecycle stage labels ride the contacts "pipeline"; a portal that hides it keeps the raw values.
  const lifecycle = new Map<string, string>();
  const contacts = (await http.getJson(`${base}/crm/v3/pipelines/contacts`).catch(() => null)) as {
    results?: Array<{ stages?: Array<{ id: string; label: string }> }>;
  } | null;
  for (const p of contacts?.results ?? [])
    for (const s of p.stages ?? []) lifecycle.set(String(s.id), s.label);
  return { owners, stages, pipelines, lifecycle };
}

/** What a row is read with: the run's lookups and its association targets. */
interface RowContext {
  lookups: Lookups;
  assoc: Record<string, string[]>;
}

/** One HubSpot object → the envelope: flat attributes with ids resolved to labels, relations from the associations. */
export function toEnvelope(entity: string, row: HubSpotRow, rc: RowContext): RecordEnvelope | null {
  const spec = OBJECTS[entity];
  if (!spec || !row?.id) return null;
  const p = row.properties ?? {};
  const modified = p[spec.modified];
  const relations = spec.associations.flatMap((a) => {
    const ids = rc.assoc[a.to] ?? [];
    return (a.onlyFirst ? ids.slice(0, 1) : ids).map((id) => ({
      kind: a.kind,
      targetType: a.targetType,
      targetExternalId: id,
    }));
  });
  const common = {
    externalId: String(row.id),
    relations,
    ...(modified ? { updatedAt: isoOf(modified) } : {}),
  };
  switch (entity) {
    case 'deal':
      return { entityType: 'deal', ...dealOf(row, p, rc.lookups), ...common };
    case 'person':
      return { entityType: 'person', ...personOf(row, p, rc.lookups), ...common };
    case 'organization':
      return { entityType: 'organization', ...organizationOf(row, p, rc.lookups), ...common };
    default:
      return null;
  }
}

type Props = Record<string, string | null>;

function dealOf(
  row: HubSpotRow,
  p: Props,
  l: Lookups,
): Pick<RecordEnvelope, 'name' | 'attributes'> {
  return {
    name: p.dealname || `deal ${row.id}`,
    attributes: scalars({
      amount: numberOf(p.amount),
      currency: p.deal_currency_code,
      status: p.hs_is_closed_won === 'true' ? 'won' : p.hs_is_closed === 'true' ? 'lost' : 'open',
      stage: labelOf(l.stages, p.dealstage),
      pipeline: labelOf(l.pipelines, p.pipeline),
      owner: ownerOf(l, p),
      close_date: dateOf(p.closedate),
      probability: numberOf(p.hs_deal_stage_probability),
      lost_reason: p.closed_lost_reason,
      next_step: p.hs_next_step,
      created: dateOf(p.createdate),
    }),
  };
}

function personOf(
  row: HubSpotRow,
  p: Props,
  l: Lookups,
): Pick<RecordEnvelope, 'name' | 'attributes'> {
  return {
    name: `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim() || p.email || `contact ${row.id}`,
    attributes: scalars({
      email: p.email,
      phone: p.phone,
      job_title: p.jobtitle,
      company: p.company,
      owner: ownerOf(l, p),
      lifecycle_stage: labelOf(l.lifecycle, p.lifecyclestage),
      lead_status: p.hs_lead_status,
      created: dateOf(p.createdate),
    }),
  };
}

function organizationOf(
  row: HubSpotRow,
  p: Props,
  l: Lookups,
): Pick<RecordEnvelope, 'name' | 'attributes'> {
  return {
    name: p.name || p.domain || `company ${row.id}`,
    attributes: scalars({
      domain: p.domain,
      industry: p.industry,
      city: p.city,
      country: p.country,
      employees: numberOf(p.numberofemployees),
      revenue: numberOf(p.annualrevenue),
      owner: ownerOf(l, p),
      lifecycle_stage: labelOf(l.lifecycle, p.lifecyclestage),
      created: dateOf(p.createdate),
    }),
  };
}

/** A label for an id, the id itself when the lookup does not know it, nothing for no id. */
function labelOf(table: Map<string, string>, id: string | null | undefined): string | undefined {
  return id ? (table.get(id) ?? id) : undefined;
}

function ownerOf(l: Lookups, p: Props): string | undefined {
  return p.hubspot_owner_id ? l.owners.get(p.hubspot_owner_id) : undefined;
}

function dateOf(v: string | null | undefined): string | undefined {
  return v ? isoOf(v) : undefined;
}

function numberOf(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function apiBase(): string {
  return providerEndpoints('hubspot').apiBase;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('hubspot: no connected account or access token on this connection');
  return cloudHttp({ token, private: providerEndpoints('hubspot').private, signal: ctx.signal });
}
