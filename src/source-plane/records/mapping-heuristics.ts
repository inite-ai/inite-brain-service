import type { RestEntity } from '../../contracts/source-plane/source-plane.schema';
import { rowsOf, valueAt } from '../connectors/rest-records.connector';
import type { ApiDigest, OperationDigest, ParamDigest } from './openapi-digest';
import type { EntityMapping, Vocabulary } from './record-mapping';

/**
 * The deterministic half of the mapping assistant
 * (docs/roadmap/crm-sources-2026-09.md § 4.3): from a list operation
 * (an OpenAPI digest) or a sample answer, propose the `rest_records`
 * endpoint — the entity type in the brain's own vocabulary, where the
 * rows sit, the id / name / updated-at fields, the paging style and
 * the incremental parameter by their conventional names, the relation
 * fields by their `<entity>_id` shape — and the field → predicate
 * mapping from a synonym table over the pack's vocabulary. Free, in
 * process, always on; the model (when the operator enabled it) refines
 * this proposal rather than starting from nothing, and the preview
 * decides.
 */

export interface EntityProposal {
  type: string;
  label: string;
  endpoint: RestEntity;
  source: 'openapi' | 'sample';
  confidence: number;
  reason: string;
  /** The attribute keys the rows carry (the mapping table's rows). */
  attributeKeys: string[];
}

/** Vendor collection nouns → the brain's entity type (the crm_memory vocabulary's subjects). */
const TYPE_ALIASES: Record<string, string> = {
  deals: 'deal',
  deal: 'deal',
  opportunities: 'deal',
  opportunity: 'deal',
  leads: 'lead',
  lead: 'lead',
  persons: 'person',
  person: 'person',
  people: 'person',
  contacts: 'person',
  contact: 'person',
  organizations: 'organization',
  organisations: 'organization',
  organization: 'organization',
  organisation: 'organization',
  companies: 'organization',
  company: 'organization',
  accounts: 'organization',
  account: 'organization',
  tickets: 'ticket',
  ticket: 'ticket',
  issues: 'ticket',
  tasks: 'task',
  task: 'task',
  products: 'product',
  product: 'product',
  projects: 'project',
  project: 'project',
  orders: 'order',
  order: 'order',
  invoices: 'invoice',
  invoice: 'invoice',
};

/** Collections that are lookups or plumbing, never records to remember. */
const SKIP_COLLECTIONS = new Set([
  'users',
  'owners',
  'stages',
  'pipelines',
  'statuses',
  'currencies',
  'fields',
  'webhooks',
  'filters',
  'permissions',
  'roles',
  'settings',
  'me',
  'search',
  'activities',
  'notes',
  'files',
  'attachments',
  'logs',
  'events',
  'batch',
]);

const ID_KEYS = ['id', 'ID', '_id', 'uuid', 'Id'];
const NAME_KEYS = [
  'name',
  'title',
  'full_name',
  'fullName',
  'dealname',
  'display_name',
  'displayName',
  'subject',
  'label',
  'company_name',
  'companyName',
];
const FIRST_LAST: Array<[string, string]> = [
  ['first_name', 'last_name'],
  ['firstname', 'lastname'],
  ['firstName', 'lastName'],
  ['name', 'lastName'],
];
const UPDATED_KEYS = [
  'updated_at',
  'updatedAt',
  'update_time',
  'updatedTime',
  'updated',
  'modified',
  'modified_at',
  'modifiedAt',
  'last_modified',
  'lastModified',
  'last_modified_at',
  'hs_lastmodifieddate',
  'lastmodifieddate',
  'date_modified',
  'changed_at',
];
const DELETED_KEYS = ['is_deleted', 'deleted', 'isDeleted'];

const CURSOR_PARAMS = /^(cursor|after|next_cursor|page_token|pageToken|starting_after|next)$/i;
const PAGE_PARAMS = /^(page|page_number|pageNumber|page_no)$/i;
const OFFSET_PARAMS = /^(offset|start|skip)$/i;
const SIZE_PARAMS = /^(limit|per_page|perPage|page_size|pageSize|count|max_results|maxResults)$/i;
const SINCE_PARAMS =
  /^(updated_since|since|modified_since|updated_after|updated_at_min|updatedSince|modifiedSince|changed_since|last_modified_after|lastModifiedAfter|updated_from|modified_after|from_date|filter\[updated_at\]\[from\]|>updatedTime)$/i;

/** Relation fields: `<noun>_id` / `<noun>Id`, or an object-valued `<noun>`, where the noun is an entity we know. */
const RELATION_NOUNS: Record<string, { targetType: string; kind: string }> = {
  person: { targetType: 'person', kind: 'primary_contact' },
  contact: { targetType: 'person', kind: 'primary_contact' },
  primary_contact: { targetType: 'person', kind: 'primary_contact' },
  org: { targetType: 'organization', kind: 'organization' },
  organization: { targetType: 'organization', kind: 'organization' },
  organisation: { targetType: 'organization', kind: 'organization' },
  company: { targetType: 'organization', kind: 'organization' },
  account: { targetType: 'organization', kind: 'organization' },
  deal: { targetType: 'deal', kind: 'deal' },
  opportunity: { targetType: 'deal', kind: 'deal' },
  lead: { targetType: 'lead', kind: 'lead' },
  ticket: { targetType: 'ticket', kind: 'ticket' },
};

/** Attribute key → predicate localId, tried in order; the predicate must exist in the vocabulary. */
const SYNONYMS: Array<[RegExp, string]> = [
  [/^(amount|value|price|sum|opportunity|deal_amount|total|total_amount)$/i, 'deal_amount'],
  [/^(currency|currency_code|currencyid|currency_id|deal_currency_code)$/i, 'currency'],
  [/^(stage|stage_id|stageid|stage_name|dealstage|deal_stage|status_id|statusid)$/i, 'deal_stage'],
  [
    /^(pipeline|pipeline_id|pipelineid|pipeline_name|category|category_id|categoryid)$/i,
    'pipeline',
  ],
  [
    /^(owner|owner_id|ownerid|owner_name|responsible|responsible_user_id|responsible_user|assigned|assigned_to|assignee|assignedbyid|hubspot_owner_id)$/i,
    'owner',
  ],
  [/^(probability|win_probability|hs_deal_stage_probability)$/i, 'probability'],
  [
    /^(expected_close|expected_close_date|close_date|closedate|closing_date|expected_closing_date|expected_close_at)$/i,
    'expected_close',
  ],
  [/^(won_time|won_at|won_date)$/i, 'won_at'],
  [/^(lost_time|lost_at|lost_date)$/i, 'lost_at'],
  [/^(lost_reason|loss_reason|loss_reason_id|closed_lost_reason)$/i, 'lost_reason'],
  [/^(next_step|next_activity|next_action|hs_next_step)$/i, 'next_step'],
  [/^(job_title|jobtitle|position|post|role|title_at_company)$/i, 'job_title'],
  [/^(industry|industry_id|sector)$/i, 'industry'],
  [/^(website|web|domain|url|site|homepage|www)$/i, 'website'],
  [/^(source|lead_source|source_id|sourceid|channel|origin|utm_source)$/i, 'lead_source'],
  [
    /^(lifecycle_stage|lifecyclestage|lifecycle|customer_status|contact_status)$/i,
    'lifecycle_stage',
  ],
];

/** Entity kinds the crm_memory vocabulary speaks about. */
const DEAL_LIKE = new Set(['deal', 'lead', 'opportunity', 'ticket', 'order', 'project']);
const PARTY_LIKE = new Set(['person', 'organization', 'contact', 'company', 'account', 'customer']);

/** The brain's entity type for a vendor collection name; null for a lookup collection. */
export function entityTypeOf(collection: string): string | null {
  const noun = collection.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (SKIP_COLLECTIONS.has(noun)) return null;
  const known = TYPE_ALIASES[noun];
  if (known) return known;
  const singular = noun.endsWith('ies')
    ? `${noun.slice(0, -3)}y`
    : noun.endsWith('ses') || noun.endsWith('xes')
      ? noun.slice(0, -2)
      : noun.endsWith('s') && !noun.endsWith('ss')
        ? noun.slice(0, -1)
        : noun;
  const clean = singular.replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]{0,31}$/.test(clean) ? clean : null;
}

/** The collection a path names: its last literal segment, past a trailing verb (`/tickets/search` → `tickets`). */
function collectionOf(path: string): string | null {
  const parts = path
    .split('?')[0]!
    .split('/')
    .filter((p) => p && !/^[{:]/.test(p));
  const last = parts.at(-1) ?? null;
  return last && TRAILING_VERB.test(last) && parts.length > 1 ? parts.at(-2)! : last;
}

const TRAILING_VERB = /^(search|list|query|find|filter|all)$/i;

/** Proposals from an OpenAPI digest: one per list operation that names a record collection (the plainest path per entity wins). */
export function proposeFromOperations(digest: ApiDigest): EntityProposal[] {
  const byType = new Map<string, EntityProposal>();
  for (const op of digest.operations) {
    // A path ending in a parameter is a `get`, not a list.
    if (/\/[{:][^/]+$/.test(op.path)) continue;
    const collection = collectionOf(op.path);
    if (!collection) continue;
    const type = entityTypeOf(collection);
    if (!type) continue;
    const proposal = proposalFromOperation({ op, type, collection, digest });
    const existing = byType.get(type);
    if (!existing || existing.endpoint.list.path.length > proposal.endpoint.list.path.length) {
      byType.set(type, proposal);
    }
  }
  return [...byType.values()];
}

function proposalFromOperation(p: {
  op: OperationDigest;
  type: string;
  collection: string;
  digest: ApiDigest;
}): EntityProposal {
  const { op, type, collection, digest } = p;
  const keys = op.properties.map((p) => p.name);
  const fields = fieldsOf(keys);
  // A GET takes its knobs in the query, a POST search in its body.
  const where = op.method === 'POST' ? 'body' : 'query';
  const paging = pagingOf(op.params, op.answerKeys, where);
  const incremental = incrementalOf(op.params, where);
  const relations = relationsOf({
    keys,
    types: op.properties.map((x) => x.type),
    sourceType: type,
  });
  const get = getPathOf(op.path, digest);
  const reasons = [
    `${op.method} ${op.path} answers a list of ${collection}${op.itemsPath ? ` under \`${op.itemsPath}\`` : ''}`,
    `id \`${fields.id}\`, name \`${fields.name.join(' + ')}\`${fields.updatedAt ? `, updated-at \`${fields.updatedAt}\`` : ', no updated-at field (every run re-reads everything)'}`,
    paging
      ? `paging: ${paging.style}${paging.param ? ` on \`${paging.param}\`` : ''}`
      : 'no paging parameter seen',
    incremental ? `incremental on \`${incremental.param}\`` : 'no updated-since parameter seen',
  ];
  let confidence = 0.5;
  if (fields.updatedAt) confidence += 0.15;
  if (incremental) confidence += 0.15;
  if (paging) confidence += 0.1;
  if (NAME_KEYS.includes(fields.name[0]!)) confidence += 0.1;
  return {
    type,
    label: type,
    endpoint: {
      label: type,
      list: {
        path: op.path,
        ...(op.method === 'POST' ? { method: 'POST' as const } : {}),
      },
      ...(op.itemsPath ? { items: op.itemsPath } : {}),
      ...(get ? { get: { path: get } } : {}),
      ...(paging ? { paging } : {}),
      ...(incremental ? { incremental } : {}),
      fields,
      ...(relations.length ? { relations } : {}),
      ...(deletedOf(keys) ? { deleted: deletedOf(keys)! } : {}),
    },
    source: 'openapi',
    confidence: Math.min(confidence, 0.95),
    reason: reasons.join('; '),
    attributeKeys: attributeKeysOf(keys, fields, relations),
  };
}

/** `<list path>/{id}` when the document declares such a path. */
function getPathOf(listPath: string, digest: ApiDigest): string | null {
  const escaped = listPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}/[{:][^/]+$`);
  return digest.paths.some((p) => re.test(p)) ? `${listPath}/{id}` : null;
}

/** A proposal from a sample list answer (what a curl of the endpoint returned). */
export function proposeFromSample(sample: {
  type?: string | undefined;
  path?: string | undefined;
  json: unknown;
}): EntityProposal | null {
  const located = locateRows(sample.json);
  if (!located || located.rows.length === 0) return null;
  const collection = sample.path ? collectionOf(sample.path) : null;
  const type = sample.type ?? (collection ? entityTypeOf(collection) : null) ?? 'record';
  const rows = located.rows.slice(0, 20);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const types = keys.map((k) => {
    const v = rows.find((r) => r[k] !== null && r[k] !== undefined)?.[k];
    return v === undefined ? null : Array.isArray(v) ? 'array' : typeof v;
  });
  const fields = fieldsOf(keys);
  const relations = relationsOf({ keys, types, sourceType: type });
  const paging = pagingFromAnswer(sample.json, located.path);
  const reasons = [
    `${rows.length} row(s)${located.path ? ` under \`${located.path}\`` : ' at the top level'} with ${keys.length} field(s)`,
    `id \`${fields.id}\`, name \`${fields.name.join(' + ')}\`${fields.updatedAt ? `, updated-at \`${fields.updatedAt}\`` : ', no updated-at field'}`,
    paging
      ? `paging: ${paging.style} (next at \`${paging.next}\`)`
      : 'no paging seen in the answer',
    'the incremental parameter cannot be read from an answer — set it by hand if the API has one',
  ];
  return {
    type,
    label: type,
    endpoint: {
      label: type,
      list: { path: sample.path ?? `/${collection ?? type}` },
      ...(located.path ? { items: located.path } : {}),
      ...(paging ? { paging } : {}),
      fields,
      ...(relations.length ? { relations } : {}),
      ...(deletedOf(keys) ? { deleted: deletedOf(keys)! } : {}),
    },
    source: 'sample',
    confidence: fields.updatedAt ? 0.6 : 0.45,
    reason: reasons.join('; '),
    attributeKeys: attributeKeysOf(keys, fields, relations),
  };
}

/** The rows in a sample answer and the dotted path to them (depth ≤ 3). */
function locateRows(
  json: unknown,
  prefix = '',
  depth = 0,
): { rows: Record<string, unknown>[]; path: string } | null {
  if (Array.isArray(json)) {
    const rows = rowsOf(json, undefined);
    return rows.length ? { rows, path: prefix } : null;
  }
  if (!json || typeof json !== 'object' || depth >= 3) return null;
  const entries = Object.entries(json as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      const found = locateRows(v, prefix ? `${prefix}.${k}` : k, depth + 1);
      if (found) return found;
    }
  }
  for (const [k, v] of entries) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = locateRows(v, prefix ? `${prefix}.${k}` : k, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function fieldsOf(keys: string[]): RestEntity['fields'] {
  const id =
    ID_KEYS.find((k) => keys.includes(k)) ??
    keys.find(
      (k) => /(_id|Id|ID)$/.test(k) && !/^(owner|user|parent|pipeline|stage|status)/i.test(k),
    ) ??
    'id';
  const pair = FIRST_LAST.find(([a, b]) => keys.includes(a) && keys.includes(b));
  const single = NAME_KEYS.find((k) => keys.includes(k));
  // Bitrix24's contact is `name` + `lastName`; a `name` next to first/last is the full one.
  const name =
    pair && pair[0] === 'name' ? [pair[0], pair[1]] : single ? [single] : pair ? [...pair] : [id];
  const updatedAt = UPDATED_KEYS.find((k) => keys.includes(k));
  return { id, name, ...(updatedAt ? { updatedAt } : {}) };
}

function deletedOf(keys: string[]): string | undefined {
  return DELETED_KEYS.find((k) => keys.includes(k));
}

function relationsOf(p: {
  keys: string[];
  types: Array<string | null>;
  /** The entity the rows are — a person's company is where they work. */
  sourceType: string;
}): NonNullable<RestEntity['relations']> {
  const out: NonNullable<RestEntity['relations']> = [];
  p.keys.forEach((key, i) => {
    const m = /^(.+?)(?:_id|Id|ID)$/.exec(key);
    const noun = m ? m[1]!.toLowerCase() : p.types[i] === 'object' ? key.toLowerCase() : null;
    if (!noun) return;
    const rel = RELATION_NOUNS[noun];
    if (!rel || rel.targetType === p.sourceType) return;
    const kind =
      p.sourceType === 'person' && rel.targetType === 'organization' ? 'works_at' : rel.kind;
    if (out.some((r) => r.targetType === rel.targetType && r.kind === kind)) return;
    out.push({ kind, targetType: rel.targetType, path: key });
  });
  return out.slice(0, 8);
}

/** Every key that is not the id / name / updated-at / deleted flag / a relation — the mapping table's rows. */
function attributeKeysOf(
  keys: string[],
  fields: RestEntity['fields'],
  relations: NonNullable<RestEntity['relations']>,
): string[] {
  const claimed = new Set([
    fields.id,
    ...fields.name,
    ...(fields.updatedAt ? [fields.updatedAt] : []),
    ...DELETED_KEYS,
    ...relations.map((r) => r.path),
  ]);
  return keys.filter((k) => !claimed.has(k));
}

function pagingOf(
  params: ParamDigest[],
  answerKeys: string[],
  where: 'query' | 'body',
): RestEntity['paging'] | null {
  const query = params.filter((p) => p.in === where);
  const size = query.find((p) => SIZE_PARAMS.test(p.name))?.name;
  const cursor = query.find((p) => CURSOR_PARAMS.test(p.name));
  if (cursor) {
    const next = nextCursorPath(answerKeys, cursor.name);
    return {
      style: next?.startsWith('_links') ? 'link' : 'cursor',
      param: cursor.name,
      ...(size ? { sizeParam: size } : {}),
      ...(next ? { next } : {}),
    };
  }
  const page = query.find((p) => PAGE_PARAMS.test(p.name));
  if (page) return { style: 'page', param: page.name, ...(size ? { sizeParam: size } : {}) };
  const offset = query.find((p) => OFFSET_PARAMS.test(p.name));
  if (offset) return { style: 'offset', param: offset.name, ...(size ? { sizeParam: size } : {}) };
  return null;
}

/** Where the next cursor sits in the answer, by the wrapper's conventional keys. */
function nextCursorPath(answerKeys: string[], param: string): string | null {
  const has = (k: string) => answerKeys.includes(k);
  if (has('next_cursor')) return 'next_cursor';
  if (has('nextCursor')) return 'nextCursor';
  if (has('additional_data')) return 'additional_data.next_cursor';
  if (has('paging')) return 'paging.next.after';
  if (has('meta')) return 'meta.next_cursor';
  if (has('_links')) return '_links.next.href';
  if (has('next')) return 'next';
  if (has('next_page_token')) return 'next_page_token';
  if (has(param)) return param;
  return null;
}

/** Paging read off a sample answer's wrapper: only cursor / link styles show in an answer. */
function pagingFromAnswer(json: unknown, itemsPath: string): RestEntity['paging'] | null {
  if (!json || typeof json !== 'object' || Array.isArray(json) || itemsPath === '') return null;
  const next = nextCursorPath(Object.keys(json as Record<string, unknown>), '');
  if (!next) return null;
  const value = valueAt(json, next);
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return { style: 'link', next };
  const leaf = next.split('.').at(-1) ?? '';
  const param = leaf.replace(/^next_?/i, '') || 'cursor';
  return { style: 'cursor', param, next };
}

function incrementalOf(
  params: ParamDigest[],
  where: 'query' | 'body',
): RestEntity['incremental'] | null {
  const p = params.find((x) => x.in === where && SINCE_PARAMS.test(x.name));
  if (!p) return null;
  const format =
    p.type === 'integer' || p.type === 'number' ? 'epoch' : /date$/i.test(p.name) ? 'date' : 'iso';
  return { param: p.name, format, ...(where === 'body' ? { in: 'body' as const } : {}) };
}

/** The field → predicate mapping for an entity's attribute keys, over the pack's vocabulary. */
export function proposeMapping(type: string, keys: string[], vocab: Vocabulary): EntityMapping {
  const available = new Set([...vocab.localIds, ...vocab.corePredicates]);
  const fields: Record<string, string> = {};
  const taken = new Set<string>();
  for (const key of keys) {
    const predicate = predicateFor(type, key, available);
    if (!predicate || taken.has(predicate)) continue;
    fields[key] = predicate;
    taken.add(predicate);
  }
  return { fields, coreType: coreTypeOf(type) };
}

function predicateFor(type: string, key: string, available: Set<string>): string | null {
  const party = PARTY_LIKE.has(type);
  // A party's status is its lifecycle, a deal's is its status.
  if (party && /^(status|state)$/i.test(key)) return pick('lifecycle_stage', available);
  if (!party && /^(status|deal_status|state)$/i.test(key)) return pick('deal_status', available);
  if (party && /^title$/i.test(key)) return pick('job_title', available);
  for (const [re, predicate] of SYNONYMS) {
    if (!re.test(key)) continue;
    if (party && DEAL_ONLY.has(predicate)) continue;
    if (!party && PARTY_ONLY.has(predicate)) continue;
    return pick(predicate, available);
  }
  return null;
}

const DEAL_ONLY = new Set([
  'deal_amount',
  'deal_stage',
  'pipeline',
  'probability',
  'expected_close',
  'won_at',
  'lost_at',
  'lost_reason',
  'next_step',
]);
const PARTY_ONLY = new Set(['job_title', 'industry', 'website', 'lifecycle_stage']);

function pick(predicate: string, available: Set<string>): string | null {
  return available.has(predicate) ? predicate : null;
}

export function coreTypeOf(type: string): EntityMapping['coreType'] {
  if (DEAL_LIKE.has(type)) return 'project';
  if (PARTY_LIKE.has(type)) return 'customer';
  return 'other';
}
