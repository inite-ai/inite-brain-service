import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type { ConnectorCtx, RecordEnvelope } from '../connector';
import type { RecordMapping } from '../records/record-mapping';
import {
  RecordsConnector,
  type EntitySpec,
  type ListCursor,
  type ListPage,
} from '../records/records-connector';
import { cloudHttp, CloudHttpError, type CloudHttp } from './cloud-http';
import { isoOf, scalars } from './records-vendor';
import {
  salesforceSession,
  type SalesforceConfig,
  type SalesforceSession,
} from './salesforce-auth';
import { readBulkPage, startBulkQuery, type BulkPageState } from './salesforce-bulk';

/**
 * `salesforce` — opportunities, contacts, accounts, leads and cases of
 * a Salesforce org on the records contract (docs/roadmap/crm-sources-
 * 2026-09.md § 4.2.1, W4.2c), through SOQL over REST: one query per
 * object ordered by LastModifiedDate, `LastModifiedDate > since` for the
 * incremental walk, 2 000 a page on `nextRecordsUrl`; the deleted-ids
 * feed (`/sobjects/<Object>/deleted`) closes what was deleted since
 * the checkpoint, so deletions reach memory without a full walk. Owner
 * and account names ride as relationship fields (`Owner.Name`,
 * `Account.Name`) — no lookups. Bulk API 2.0 carries the first walk of
 * a large org when the connection asks (`config.bulk`).
 *
 * Runs as a connected account (OAuth; the org from the grant's
 * `instance_url`) or as an integration user through a JWT bearer
 * (salesforce-auth.ts). Field-level security applies as that user:
 * a field the user cannot read is absent, never an error. The dev
 * override SOURCE_OAUTH_SALESFORCE_BASE_URL reroutes the org to a fake.
 */

const DEFAULT_API_VERSION = 'v62.0';
/** The deleted-ids feed reaches back 30 days; an older checkpoint waits for the full walk. */
const DELETED_FEED_MAX_MS = 30 * 24 * 60 * 60_000;

interface ObjectSpec {
  object: string;
  fields: string[];
}

const OBJECTS: Record<string, ObjectSpec> = {
  deal: {
    object: 'Opportunity',
    fields: [
      'Id',
      'Name',
      'Amount',
      'StageName',
      'CloseDate',
      'IsClosed',
      'IsWon',
      'Probability',
      'Type',
      'LeadSource',
      'NextStep',
      'OwnerId',
      'Owner.Name',
      'AccountId',
      'Account.Name',
      'ContactId',
      'CreatedDate',
      'LastActivityDate',
      'LastModifiedDate',
    ],
  },
  person: {
    object: 'Contact',
    fields: [
      'Id',
      'Name',
      'Email',
      'Phone',
      'Title',
      'Department',
      'LeadSource',
      'AccountId',
      'Account.Name',
      'OwnerId',
      'Owner.Name',
      'CreatedDate',
      'LastModifiedDate',
    ],
  },
  organization: {
    object: 'Account',
    fields: [
      'Id',
      'Name',
      'Website',
      'Industry',
      'Phone',
      'Type',
      'BillingCity',
      'BillingCountry',
      'NumberOfEmployees',
      'AnnualRevenue',
      'ParentId',
      'OwnerId',
      'Owner.Name',
      'CreatedDate',
      'LastModifiedDate',
    ],
  },
  lead: {
    object: 'Lead',
    fields: [
      'Id',
      'Name',
      'Company',
      'Title',
      'Email',
      'Phone',
      'Status',
      'LeadSource',
      'Industry',
      'Rating',
      'IsConverted',
      'ConvertedAccountId',
      'ConvertedContactId',
      'ConvertedOpportunityId',
      'OwnerId',
      'Owner.Name',
      'CreatedDate',
      'LastModifiedDate',
    ],
  },
  ticket: {
    object: 'Case',
    fields: [
      'Id',
      'CaseNumber',
      'Subject',
      'Status',
      'Priority',
      'Origin',
      'Type',
      'Reason',
      'IsClosed',
      'ClosedDate',
      'ContactId',
      'Contact.Name',
      'AccountId',
      'Account.Name',
      'OwnerId',
      'Owner.Name',
      'CreatedDate',
      'LastModifiedDate',
    ],
  },
};

/** A row as the query endpoint (nested `Owner: { Name }`) or the bulk CSV (`Owner.Name`) returns it. */
export type SalesforceRow = Record<string, unknown>;

type QueryPage = { page: 'query'; nextRecordsUrl: string } | { page: 'bulk'; state: BulkPageState };

@Injectable()
export class SalesforceConnector extends RecordsConnector {
  readonly kind = 'salesforce';
  override readonly configExample = {
    entities: ['deal', 'person', 'organization'],
    instanceUrl: 'https://acme.my.salesforce.com',
  };
  override readonly credentialHint =
    'a connected Salesforce account (oauth:<grant id>), or a JWT bearer JSON { clientId, username, privateKey, loginUrl? }';
  override readonly oauth = { provider: 'salesforce' as const, scopes: ['api'], optional: true };
  readonly entities: EntitySpec[] = [
    {
      type: 'deal',
      label: 'Opportunities',
      defaultOn: true,
      fields: [
        { key: 'amount', label: 'Amount' },
        { key: 'stage', label: 'Stage' },
        { key: 'status', label: 'Status (open / won / lost)' },
        { key: 'probability', label: 'Probability' },
        { key: 'expected_close', label: 'Close date' },
        { key: 'type', label: 'Type' },
        { key: 'lead_source', label: 'Lead source' },
        { key: 'next_step', label: 'Next step' },
        { key: 'owner', label: 'Owner' },
        { key: 'last_activity_at', label: 'Last activity' },
        { key: 'created_at', label: 'Created at' },
      ],
    },
    {
      type: 'person',
      label: 'Contacts',
      defaultOn: true,
      fields: [
        { key: 'email', label: 'E-mail' },
        { key: 'phone', label: 'Phone' },
        { key: 'job_title', label: 'Title' },
        { key: 'department', label: 'Department' },
        { key: 'lead_source', label: 'Lead source' },
        { key: 'owner', label: 'Owner' },
        { key: 'created_at', label: 'Created at' },
      ],
    },
    {
      type: 'organization',
      label: 'Accounts',
      defaultOn: true,
      fields: [
        { key: 'website', label: 'Website' },
        { key: 'industry', label: 'Industry' },
        { key: 'phone', label: 'Phone' },
        { key: 'type', label: 'Type' },
        { key: 'city', label: 'Billing city' },
        { key: 'country', label: 'Billing country' },
        { key: 'employees', label: 'Employees' },
        { key: 'annual_revenue', label: 'Annual revenue' },
        { key: 'owner', label: 'Owner' },
        { key: 'created_at', label: 'Created at' },
      ],
    },
    {
      type: 'lead',
      label: 'Leads',
      defaultOn: false,
      fields: [
        { key: 'company', label: 'Company (as typed)' },
        { key: 'job_title', label: 'Title' },
        { key: 'email', label: 'E-mail' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
        { key: 'lead_source', label: 'Lead source' },
        { key: 'industry', label: 'Industry' },
        { key: 'rating', label: 'Rating' },
        { key: 'converted', label: 'Converted' },
        { key: 'owner', label: 'Owner' },
        { key: 'created_at', label: 'Created at' },
      ],
    },
    {
      type: 'ticket',
      label: 'Cases',
      defaultOn: false,
      fields: [
        { key: 'number', label: 'Case number' },
        { key: 'status', label: 'Status' },
        { key: 'priority', label: 'Priority' },
        { key: 'origin', label: 'Origin' },
        { key: 'type', label: 'Type' },
        { key: 'reason', label: 'Reason' },
        { key: 'owner', label: 'Owner' },
        { key: 'closed_at', label: 'Closed at' },
        { key: 'created_at', label: 'Created at' },
      ],
    },
  ];
  readonly preset: RecordMapping = {
    deal: {
      fields: {
        amount: 'deal_amount',
        stage: 'deal_stage',
        status: 'deal_status',
        probability: 'probability',
        expected_close: 'expected_close',
        lead_source: 'lead_source',
        next_step: 'next_step',
        owner: 'owner',
        last_activity_at: 'last_activity_at',
      },
      coreType: 'project',
    },
    // E-mail and phone stay in the render, unmapped (PII predicates are scope-gated).
    person: {
      fields: { job_title: 'job_title', owner: 'owner', lead_source: 'lead_source' },
      coreType: 'customer',
    },
    organization: {
      fields: { website: 'website', industry: 'industry', owner: 'owner' },
      coreType: 'customer',
    },
    // A lead is a pre-deal: its status is its stage in the lead funnel.
    lead: {
      fields: {
        status: 'deal_stage',
        job_title: 'job_title',
        lead_source: 'lead_source',
        industry: 'industry',
        owner: 'owner',
      },
      coreType: 'customer',
    },
    ticket: { fields: { owner: 'owner' }, coreType: 'topic' },
  };

  private readonly sessions = new Map<string, Promise<SalesforceSession>>();

  override enabled(): boolean {
    return sourceKindEnabled('salesforce');
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const spec = OBJECTS[entity];
    if (!spec) throw new Error(`salesforce: unknown entity "${entity}"`);
    const session = await this.sessionOf(ctx);
    const version = apiVersionOf(ctx);
    const http = httpOf(ctx, session);
    const page = cursor.page as QueryPage | null;
    if (page?.page === 'bulk' || (page === null && cursor.since === null && bulkWanted(ctx))) {
      return this.listBulk({ ctx, session, entity, spec, page, version });
    }
    const url =
      page?.page === 'query'
        ? `${session.instanceUrl}${page.nextRecordsUrl}`
        : queryUrl({ session, version, spec, since: cursor.since });
    const answer = (await http.getJson(url)) as {
      records?: SalesforceRow[];
      nextRecordsUrl?: string;
      done?: boolean;
    };
    const records = (answer.records ?? [])
      .map((row) => toEnvelope(entity, row))
      .filter((r): r is RecordEnvelope => r !== null);
    const next: QueryPage | null =
      answer.done === false && typeof answer.nextRecordsUrl === 'string'
        ? { page: 'query', nextRecordsUrl: answer.nextRecordsUrl }
        : null;
    const gone =
      page === null && cursor.since
        ? await deletedSince({ ctx, http, session, version, spec, since: cursor.since })
        : undefined;
    return { records, next, ...(gone ? { gone } : {}) };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const spec = OBJECTS[entity];
    if (!spec) return null;
    const session = await this.sessionOf(ctx);
    const url = new URL(
      `${session.instanceUrl}/services/data/${apiVersionOf(ctx)}/sobjects/${spec.object}/${encodeURIComponent(id)}`,
    );
    url.searchParams.set('fields', spec.fields.join(','));
    try {
      const row = (await httpOf(ctx, session).getJson(url.toString())) as SalesforceRow | null;
      return row ? toEnvelope(entity, row) : null;
    } catch (e) {
      if (e instanceof CloudHttpError && e.status === 404) return null;
      throw e;
    }
  }

  override async endRun(ctx: ConnectorCtx): Promise<void> {
    this.sessions.delete(ctx.connection.id);
    await super.endRun(ctx);
  }

  /** One session per run: a JWT exchange happens once, not per entity. */
  private sessionOf(ctx: ConnectorCtx): Promise<SalesforceSession> {
    let pending = this.sessions.get(ctx.connection.id);
    if (!pending) {
      pending = salesforceSession(ctx);
      pending.catch(() => this.sessions.delete(ctx.connection.id));
      this.sessions.set(ctx.connection.id, pending);
    }
    return pending;
  }

  private async listBulk(p: {
    ctx: ConnectorCtx;
    session: SalesforceSession;
    entity: string;
    spec: ObjectSpec;
    page: QueryPage | null;
    version: string;
  }): Promise<ListPage> {
    const http = { token: p.session.token, private: p.session.private, signal: p.ctx.signal };
    const state =
      p.page?.page === 'bulk'
        ? p.page.state
        : await startBulkQuery({
            http,
            instanceUrl: p.session.instanceUrl,
            apiVersion: p.version,
            soql: soqlOf(p.spec, null),
          });
    const got = await readBulkPage({
      http,
      instanceUrl: p.session.instanceUrl,
      apiVersion: p.version,
      state,
    });
    const records = got.rows
      .map((row) => toEnvelope(p.entity, row))
      .filter((r): r is RecordEnvelope => r !== null);
    return { records, next: got.next ? { page: 'bulk', state: got.next } : null };
  }
}

/** `SELECT <fields> FROM <Object> [WHERE LastModifiedDate > since] ORDER BY LastModifiedDate ASC`. */
export function soqlOf(spec: ObjectSpec, since: string | null): string {
  const where = since ? ` WHERE LastModifiedDate > ${soqlDatetime(since)}` : '';
  return `SELECT ${spec.fields.join(', ')} FROM ${spec.object}${where} ORDER BY LastModifiedDate ASC`;
}

/** A SOQL datetime literal: seconds precision, UTC, unquoted. */
export function soqlDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`salesforce: not a timestamp: ${iso}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function queryUrl(p: {
  session: SalesforceSession;
  version: string;
  spec: ObjectSpec;
  since: string | null;
}): string {
  const url = new URL(`${p.session.instanceUrl}/services/data/${p.version}/query`);
  url.searchParams.set('q', soqlOf(p.spec, p.since));
  return url.toString();
}

/** The deleted-ids feed for the window — best effort: a refusal is logged, the next full walk closes the rest. */
async function deletedSince(p: {
  ctx: ConnectorCtx;
  http: CloudHttp;
  session: SalesforceSession;
  version: string;
  spec: ObjectSpec;
  since: string;
}): Promise<string[] | undefined> {
  const start = new Date(p.since);
  if (Number.isNaN(start.getTime()) || Date.now() - start.getTime() > DELETED_FEED_MAX_MS) {
    return undefined;
  }
  const url = new URL(
    `${p.session.instanceUrl}/services/data/${p.version}/sobjects/${p.spec.object}/deleted/`,
  );
  url.searchParams.set('start', soqlDatetime(start.toISOString()));
  url.searchParams.set('end', soqlDatetime(new Date(Date.now() + 60_000).toISOString()));
  try {
    const answer = (await p.http.getJson(url.toString())) as {
      deletedRecords?: Array<{ id?: unknown }>;
    } | null;
    const ids = (answer?.deletedRecords ?? [])
      .map((r) => (typeof r.id === 'string' ? r.id : ''))
      .filter((id) => id.length > 0);
    return ids.length > 0 ? ids : undefined;
  } catch (e) {
    p.ctx.log(`salesforce: deleted-ids feed for ${p.spec.object} refused: ${(e as Error).message}`);
    return undefined;
  }
}

/** One vendor row → the envelope; nested (`Owner.Name` as `Owner: { Name }`) and flat (bulk CSV) rows alike. */
export function toEnvelope(entity: string, row: SalesforceRow): RecordEnvelope | null {
  const id = text(row, 'Id');
  if (!id) return null;
  const base = {
    externalId: id,
    ...(text(row, 'LastModifiedDate') ? { updatedAt: isoOf(text(row, 'LastModifiedDate')!) } : {}),
  };
  switch (entity) {
    case 'deal':
      return { entityType: 'deal', name: text(row, 'Name') ?? id, ...base, ...dealOf(row) };
    case 'person':
      return { entityType: 'person', name: text(row, 'Name') ?? id, ...base, ...personOf(row) };
    case 'organization':
      return {
        entityType: 'organization',
        name: text(row, 'Name') ?? id,
        ...base,
        ...organizationOf(row),
      };
    case 'lead':
      return { entityType: 'lead', name: text(row, 'Name') ?? id, ...base, ...leadOf(row) };
    case 'ticket':
      return {
        entityType: 'ticket',
        name: text(row, 'Subject') ?? `Case ${text(row, 'CaseNumber') ?? id}`,
        ...base,
        ...ticketOf(row),
      };
    default:
      return null;
  }
}

type Named = Pick<RecordEnvelope, 'attributes' | 'relations'>;

function dealOf(row: SalesforceRow): Named {
  const closed = bool(row, 'IsClosed');
  const won = bool(row, 'IsWon');
  return {
    attributes: scalars({
      amount: num(row, 'Amount'),
      stage: text(row, 'StageName'),
      status: closed ? (won ? 'won' : 'lost') : 'open',
      probability: num(row, 'Probability'),
      expected_close: dateOf(text(row, 'CloseDate')),
      type: text(row, 'Type'),
      lead_source: text(row, 'LeadSource'),
      next_step: text(row, 'NextStep'),
      owner: text(row, 'Owner.Name'),
      last_activity_at: dateOf(text(row, 'LastActivityDate')),
      created_at: dateOf(text(row, 'CreatedDate')),
    }),
    relations: [
      ...rel('primary_contact', 'person', { id: text(row, 'ContactId') }),
      ...rel('organization', 'organization', {
        id: text(row, 'AccountId'),
        name: text(row, 'Account.Name'),
      }),
    ],
  };
}

function personOf(row: SalesforceRow): Named {
  return {
    attributes: scalars({
      email: text(row, 'Email'),
      phone: text(row, 'Phone'),
      job_title: text(row, 'Title'),
      department: text(row, 'Department'),
      lead_source: text(row, 'LeadSource'),
      owner: text(row, 'Owner.Name'),
      created_at: dateOf(text(row, 'CreatedDate')),
    }),
    relations: rel('works_at', 'organization', {
      id: text(row, 'AccountId'),
      name: text(row, 'Account.Name'),
    }),
  };
}

function organizationOf(row: SalesforceRow): Named {
  return {
    attributes: scalars({
      website: text(row, 'Website'),
      industry: text(row, 'Industry'),
      phone: text(row, 'Phone'),
      type: text(row, 'Type'),
      city: text(row, 'BillingCity'),
      country: text(row, 'BillingCountry'),
      employees: num(row, 'NumberOfEmployees'),
      annual_revenue: num(row, 'AnnualRevenue'),
      owner: text(row, 'Owner.Name'),
      created_at: dateOf(text(row, 'CreatedDate')),
    }),
    relations: rel('parent', 'organization', { id: text(row, 'ParentId') }),
  };
}

function leadOf(row: SalesforceRow): Named {
  return {
    attributes: scalars({
      company: text(row, 'Company'),
      job_title: text(row, 'Title'),
      email: text(row, 'Email'),
      phone: text(row, 'Phone'),
      status: text(row, 'Status'),
      lead_source: text(row, 'LeadSource'),
      industry: text(row, 'Industry'),
      rating: text(row, 'Rating'),
      converted: bool(row, 'IsConverted'),
      owner: text(row, 'Owner.Name'),
      created_at: dateOf(text(row, 'CreatedDate')),
    }),
    relations: [
      ...rel('converted_contact', 'person', { id: text(row, 'ConvertedContactId') }),
      ...rel('converted_organization', 'organization', { id: text(row, 'ConvertedAccountId') }),
      ...rel('converted_deal', 'deal', { id: text(row, 'ConvertedOpportunityId') }),
    ],
  };
}

function ticketOf(row: SalesforceRow): Named {
  return {
    attributes: scalars({
      number: text(row, 'CaseNumber'),
      status: text(row, 'Status'),
      priority: text(row, 'Priority'),
      origin: text(row, 'Origin'),
      type: text(row, 'Type'),
      reason: text(row, 'Reason'),
      owner: text(row, 'Owner.Name'),
      closed_at: dateOf(text(row, 'ClosedDate')),
      created_at: dateOf(text(row, 'CreatedDate')),
    }),
    relations: [
      ...rel('contact', 'person', { id: text(row, 'ContactId'), name: text(row, 'Contact.Name') }),
      ...rel('organization', 'organization', {
        id: text(row, 'AccountId'),
        name: text(row, 'Account.Name'),
      }),
    ],
  };
}

function rel(
  kind: string,
  targetType: string,
  target: { id: string | undefined; name?: string | undefined },
): NonNullable<RecordEnvelope['relations']> {
  if (!target.id) return [];
  return [
    {
      kind,
      targetType,
      targetExternalId: target.id,
      ...(target.name ? { targetName: target.name } : {}),
    },
  ];
}

/** A field by its query name — `Owner.Name` is nested in a query answer and flat in a bulk CSV row. */
export function text(row: SalesforceRow, field: string): string | undefined {
  let v: unknown = row[field];
  if (v === undefined && field.includes('.')) {
    v = row;
    for (const part of field.split('.')) {
      v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    }
  }
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}

function num(row: SalesforceRow, field: string): number | undefined {
  const s = text(row, field);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function bool(row: SalesforceRow, field: string): boolean {
  const s = text(row, field);
  return s === 'true' || s === '1';
}

function dateOf(v: string | undefined): string | undefined {
  return v ? isoOf(v) : undefined;
}

function apiVersionOf(ctx: ConnectorCtx): string {
  const raw = (ctx.connection.config as SalesforceConfig).apiVersion?.trim();
  return raw && /^v\d{2}\.\d$/.test(raw) ? raw : DEFAULT_API_VERSION;
}

function bulkWanted(ctx: ConnectorCtx): boolean {
  return (ctx.connection.config as SalesforceConfig).bulk === true;
}

function httpOf(ctx: ConnectorCtx, session: SalesforceSession): CloudHttp {
  return cloudHttp({ token: session.token, private: session.private, signal: ctx.signal });
}
