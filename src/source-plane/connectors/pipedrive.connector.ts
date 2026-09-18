import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type { ConnectorCtx, RecordEnvelope } from '../connector';
import { providerEndpoints } from '../oauth/oauth-providers';
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
 * `pipedrive` — the first CRM connector on the records contract
 * (docs/roadmap/crm-sources-2026-09.md § 4.2): deals, persons and
 * organizations of a Pipedrive account through API v2 — `updated_since`
 * + `cursor` per entity, 500 a page, sorted by update time — as a
 * connected account (OAuth; bearer) or with an API token
 * (`x-api-token`). Stage, pipeline and owner ids are resolved to their
 * names once per run (`/api/v2/stages`, `/api/v2/pipelines`,
 * `/v1/users`), so a fact reads `deal_stage: Negotiation`, not `7`.
 * Deletions reach the catalogue on a full walk (a deleted deal is not
 * listed) and, later, through webhooks.
 *
 * `config.apiDomain` (the `api_domain` an OAuth grant names, e.g.
 * `https://acme.pipedrive.com`) replaces the public API host; the
 * dev override SOURCE_OAUTH_PIPEDRIVE_BASE_URL replaces both.
 */

export interface PipedriveConfig {
  entities?: string[] | undefined;
  mapping?: RecordMapping | undefined;
  apiDomain?: string | undefined;
}

const PAGE_LIMIT = 500;

interface Lookups {
  stages: Map<number, { name: string; pipelineId: number | null }>;
  pipelines: Map<number, string>;
  users: Map<number, string>;
}

interface PipedriveDeal {
  id: number;
  title: string;
  value?: number | null;
  currency?: string | null;
  status?: string | null;
  stage_id?: number | null;
  pipeline_id?: number | null;
  owner_id?: number | null;
  person_id?: number | null;
  org_id?: number | null;
  add_time?: string | null;
  update_time?: string | null;
  expected_close_date?: string | null;
  won_time?: string | null;
  lost_time?: string | null;
  lost_reason?: string | null;
  probability?: number | null;
  is_deleted?: boolean;
}

interface PipedrivePerson {
  id: number;
  name: string;
  job_title?: string | null;
  owner_id?: number | null;
  org_id?: number | null;
  emails?: Array<{ value: string; primary?: boolean; label?: string }>;
  phones?: Array<{ value: string; primary?: boolean; label?: string }>;
  add_time?: string | null;
  update_time?: string | null;
  is_deleted?: boolean;
}

interface PipedriveOrganization {
  id: number;
  name: string;
  owner_id?: number | null;
  address?: { value?: string | null } | string | null;
  add_time?: string | null;
  update_time?: string | null;
  is_deleted?: boolean;
}

@Injectable()
export class PipedriveConnector extends RecordsConnector {
  readonly kind = 'pipedrive';
  override readonly configExample = { entities: ['deal', 'person', 'organization'] };
  override readonly credentialHint =
    'a connected Pipedrive account (oauth:<grant id>), or an API token';
  override readonly oauth = { provider: 'pipedrive' as const, scopes: [], optional: true };
  readonly entities: EntitySpec[] = [
    {
      type: 'deal',
      label: 'Deals',
      defaultOn: true,
      fields: [
        { key: 'value', label: 'Value' },
        { key: 'currency', label: 'Currency' },
        { key: 'status', label: 'Status (open / won / lost)' },
        { key: 'stage', label: 'Stage' },
        { key: 'pipeline', label: 'Pipeline' },
        { key: 'owner', label: 'Owner' },
        { key: 'expected_close_date', label: 'Expected close date' },
        { key: 'won_time', label: 'Won at' },
        { key: 'lost_time', label: 'Lost at' },
        { key: 'lost_reason', label: 'Lost reason' },
        { key: 'probability', label: 'Probability' },
        { key: 'add_time', label: 'Created at' },
      ],
    },
    {
      type: 'person',
      label: 'Persons',
      defaultOn: true,
      fields: [
        { key: 'email', label: 'Primary e-mail' },
        { key: 'phone', label: 'Primary phone' },
        { key: 'job_title', label: 'Job title' },
        { key: 'owner', label: 'Owner' },
        { key: 'add_time', label: 'Created at' },
      ],
    },
    {
      type: 'organization',
      label: 'Organizations',
      defaultOn: true,
      fields: [
        { key: 'owner', label: 'Owner' },
        { key: 'address', label: 'Address' },
        { key: 'add_time', label: 'Created at' },
      ],
    },
  ];
  readonly preset: RecordMapping = {
    deal: {
      fields: {
        value: 'deal_amount',
        currency: 'currency',
        status: 'deal_status',
        stage: 'deal_stage',
        pipeline: 'pipeline',
        owner: 'owner',
        expected_close_date: 'expected_close',
        won_time: 'won_at',
        lost_time: 'lost_at',
        lost_reason: 'lost_reason',
        probability: 'probability',
      },
      coreType: 'project',
    },
    // E-mail and phone stay in the render (searchable) but are not
    // mapped: the core `email` / `phone` predicates are PII a deployment
    // scope-gates, and an external indexer may not seed a gated one.
    person: {
      fields: { job_title: 'job_title', owner: 'owner' },
      coreType: 'customer',
    },
    organization: { fields: { owner: 'owner' }, coreType: 'customer' },
  };

  private readonly lookups = new Map<string, Promise<Lookups>>();

  override enabled(): boolean {
    return sourceKindEnabled('pipedrive');
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const http = httpOf(ctx);
    const base = apiBase(ctx);
    const path = PATHS[entity];
    if (!path) throw new Error(`pipedrive: unknown entity "${entity}"`);
    const url = new URL(`${base}/api/v2/${path}`);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('sort_by', 'update_time');
    url.searchParams.set('sort_direction', 'asc');
    if (cursor.since) url.searchParams.set('updated_since', cursor.since);
    if (typeof cursor.page === 'string' && cursor.page) url.searchParams.set('cursor', cursor.page);
    const page = (await http.getJson(url.toString())) as {
      data?: unknown[];
      additional_data?: { next_cursor?: string | null };
    };
    const lookups = await this.lookupsOf(ctx, http, base);
    const records = (page.data ?? [])
      .map((row) => toEnvelope(entity, row, lookups))
      .filter((r): r is RecordEnvelope => r !== null);
    return { records, next: page.additional_data?.next_cursor ?? null };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const http = httpOf(ctx);
    const base = apiBase(ctx);
    const path = PATHS[entity];
    if (!path) return null;
    const got = (await http.getJson(`${base}/api/v2/${path}/${encodeURIComponent(id)}`)) as {
      data?: unknown;
    };
    if (!got.data) return null;
    return toEnvelope(entity, got.data, await this.lookupsOf(ctx, http, base));
  }

  override async endRun(ctx: ConnectorCtx): Promise<void> {
    this.lookups.delete(ctx.connection.id);
    await super.endRun(ctx);
  }

  /** Stage / pipeline / user names, once per run. */
  private lookupsOf(ctx: ConnectorCtx, http: CloudHttp, base: string): Promise<Lookups> {
    let pending = this.lookups.get(ctx.connection.id);
    if (!pending) {
      pending = loadLookups(http, base);
      this.lookups.set(ctx.connection.id, pending);
    }
    return pending;
  }
}

const PATHS: Record<string, string> = {
  deal: 'deals',
  person: 'persons',
  organization: 'organizations',
};

async function loadLookups(http: CloudHttp, base: string): Promise<Lookups> {
  const [stages, pipelines, users] = await Promise.all([
    http.getJson(`${base}/api/v2/stages?limit=500`) as Promise<{
      data?: Array<{ id: number; name: string; pipeline_id?: number | null }>;
    }>,
    http.getJson(`${base}/api/v2/pipelines?limit=500`) as Promise<{
      data?: Array<{ id: number; name: string }>;
    }>,
    http.getJson(`${base}/v1/users`) as Promise<{ data?: Array<{ id: number; name: string }> }>,
  ]);
  return {
    stages: new Map(
      (stages.data ?? []).map((s) => [s.id, { name: s.name, pipelineId: s.pipeline_id ?? null }]),
    ),
    pipelines: new Map((pipelines.data ?? []).map((p) => [p.id, p.name])),
    users: new Map((users.data ?? []).map((u) => [u.id, u.name])),
  };
}

/** One vendor row → the envelope: flat scalar attributes, names resolved, relations by id. */
export function toEnvelope(entity: string, row: unknown, l: Lookups): RecordEnvelope | null {
  if (!row || typeof row !== 'object') return null;
  if ((row as { is_deleted?: boolean }).is_deleted) return null;
  switch (entity) {
    case 'deal': {
      const d = row as PipedriveDeal;
      const stage = d.stage_id != null ? l.stages.get(d.stage_id) : undefined;
      return {
        entityType: 'deal',
        externalId: String(d.id),
        name: d.title,
        attributes: scalars({
          value: d.value,
          currency: d.currency,
          status: d.status,
          stage: stage?.name,
          pipeline:
            d.pipeline_id != null
              ? l.pipelines.get(d.pipeline_id)
              : stage?.pipelineId != null
                ? l.pipelines.get(stage.pipelineId)
                : undefined,
          owner: d.owner_id != null ? l.users.get(d.owner_id) : undefined,
          expected_close_date: d.expected_close_date,
          won_time: d.won_time,
          lost_time: d.lost_time,
          lost_reason: d.lost_reason,
          probability: d.probability,
          add_time: d.add_time,
        }),
        relations: [
          ...(d.person_id != null
            ? [
                {
                  kind: 'primary_contact',
                  targetType: 'person',
                  targetExternalId: String(d.person_id),
                },
              ]
            : []),
          ...(d.org_id != null
            ? [
                {
                  kind: 'organization',
                  targetType: 'organization',
                  targetExternalId: String(d.org_id),
                },
              ]
            : []),
        ],
        ...(d.update_time ? { updatedAt: isoOf(d.update_time) } : {}),
      };
    }
    case 'person': {
      const p = row as PipedrivePerson;
      return {
        entityType: 'person',
        externalId: String(p.id),
        name: p.name,
        attributes: scalars({
          email: primary(p.emails),
          phone: primary(p.phones),
          job_title: p.job_title,
          owner: p.owner_id != null ? l.users.get(p.owner_id) : undefined,
          add_time: p.add_time,
        }),
        relations:
          p.org_id != null
            ? [{ kind: 'works_at', targetType: 'organization', targetExternalId: String(p.org_id) }]
            : [],
        ...(p.update_time ? { updatedAt: isoOf(p.update_time) } : {}),
      };
    }
    case 'organization': {
      const o = row as PipedriveOrganization;
      return {
        entityType: 'organization',
        externalId: String(o.id),
        name: o.name,
        attributes: scalars({
          owner: o.owner_id != null ? l.users.get(o.owner_id) : undefined,
          address: typeof o.address === 'string' ? o.address : (o.address?.value ?? undefined),
          add_time: o.add_time,
        }),
        relations: [],
        ...(o.update_time ? { updatedAt: isoOf(o.update_time) } : {}),
      };
    }
    default:
      return null;
  }
}

function primary(
  items: Array<{ value: string; primary?: boolean }> | undefined,
): string | undefined {
  if (!items?.length) return undefined;
  return (items.find((i) => i.primary) ?? items[0])?.value || undefined;
}

function apiBase(ctx: ConnectorCtx): string {
  const ep = providerEndpoints('pipedrive');
  if (ep.private) return ep.apiBase;
  const own = (configOf(ctx) as PipedriveConfig).apiDomain?.trim().replace(/\/$/, '');
  return own || ep.apiBase;
}

function httpOf(ctx: ConnectorCtx): CloudHttp {
  const token = ctx.connection.credential;
  if (!token) throw new Error('pipedrive: no connected account or API token on this connection');
  const ep = providerEndpoints('pipedrive');
  // A connected account is a bearer; an operator's API token rides Pipedrive's own header.
  const asApiToken = ctx.connection.credentialSource === 'secret';
  return cloudHttp({
    token,
    private: ep.private,
    signal: ctx.signal,
    ...(asApiToken ? { headers: { 'x-api-token': token }, bearer: false } : {}),
  });
}
