import { Injectable } from '@nestjs/common';
import { sourceKindEnabled } from '../../common/source-plane-flags';
import type {
  RestEntity,
  RestRecordsConfig,
} from '../../contracts/source-plane/source-plane.schema';
import { RestRecordsConfigSchema } from '../../contracts/source-plane/source-plane.schema';
import type { ConnectorCtx, RecordEnvelope } from '../connector';
import type { RecordMapping } from '../records/record-mapping';
import { signedWebhook } from '../records/webhook-schemes';
import {
  RecordsConnector,
  configOf,
  type EntitySpec,
  type ListCursor,
  type ListPage,
  type RecordsConnectionConfig,
} from '../records/records-connector';
import { cloudHttp, type CloudHttp } from './cloud-http';
import { isoOf, scalars, type Scalar } from './records-vendor';

/**
 * `rest_records` — the long tail on the records contract
 * (docs/roadmap/crm-sources-2026-09.md § 4.3): a CRM / ERP / ticketing
 * backend with no connector of its own, described as CONFIG rather than
 * code. Per entity type the config names a list endpoint, where the
 * rows sit in the answer, one of five paging styles (`none`, `page`,
 * `offset`, `cursor`, `link`), one incremental filter (a parameter and
 * the timestamp format it wants), the id / name / updated-at fields,
 * which attributes to read (or every top-level scalar) and which fields
 * point at other records — dotted paths only, no expressions, no code.
 * The mapping assistant proposes that config from an OpenAPI document
 * or a sample answer; the preview verifies it by execution before
 * anything is connected. The runtime (checkpoints, overlap, the run
 * cache, naming targets, the gone sweep) and the door are the same as
 * every vendor's.
 *
 * The credential rides as the config's `authScheme` says — `bearer`
 * (default), `basic`, `header:<Name>`, `query:<name>` — and never
 * appears in an error. `allowPrivate` is the connection's half of the
 * private-egress opt-in, as on every network connector.
 */

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 5000;

@Injectable()
export class RestRecordsConnector extends RecordsConnector {
  readonly kind = 'rest_records';
  override readonly configExample = {
    baseUrl: 'https://crm.example.com/api',
    authScheme: 'bearer',
    endpoints: {
      deal: {
        list: { path: '/deals' },
        items: 'data',
        paging: { style: 'cursor', param: 'cursor', next: 'next_cursor' },
        incremental: { param: 'updated_since', format: 'iso' },
        fields: { id: 'id', name: ['title'], updatedAt: 'updated_at' },
      },
    },
  };
  override readonly credentialHint =
    "the API's credential — a bearer token by default; config.authScheme picks basic / header:<Name> / query:<name>";
  /** A custom backend or an automation posts `{ events: [{ entity, id, deleted? }] }`, signed or tokened. */
  override readonly webhook = signedWebhook;
  /** Static none: the entities are the connection's config. */
  readonly entities: EntitySpec[] = [];
  readonly preset: RecordMapping = {};

  override enabled(): boolean {
    return sourceKindEnabled('rest_records');
  }

  override entitiesFor(cfg: RecordsConnectionConfig): EntitySpec[] {
    return entitySpecsOf((cfg as Partial<RestRecordsConfig>).endpoints ?? {});
  }

  async list(ctx: ConnectorCtx, entity: string, cursor: ListCursor): Promise<ListPage> {
    const cfg = restConfigOf(ctx);
    const spec = cfg.endpoints[entity];
    if (!spec) throw new Error(`rest_records: no endpoint configured for "${entity}"`);
    const http = httpOf(ctx, cfg);
    const page = pageStateOf(spec, cursor);
    const req = listRequest({ cfg, spec, since: cursor.since, page });
    const answer = await call(http, req);
    const rows = rowsOf(answer, spec.items);
    const records = rows
      .map((row) => toEnvelope(entity, row, spec))
      .filter((r): r is RecordEnvelope => r !== null);
    return { records, next: nextPage({ spec, page, answer, rows: rows.length }) };
  }

  override async get(
    ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    const cfg = restConfigOf(ctx);
    const spec = cfg.endpoints[entity];
    // Null means "the backend says it is gone"; a missing get endpoint is a configuration fact, named as such.
    if (!spec?.get) throw new Error(`rest_records: no get endpoint configured for "${entity}"`);
    const http = httpOf(ctx, cfg);
    const url = resolveUrl(cfg.baseUrl, spec.get.path.replace('{id}', encodeURIComponent(id)));
    let answer: unknown;
    try {
      answer = await call(http, { method: 'GET', url });
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
    const row = rowOf(answer, spec);
    return row ? toEnvelope(entity, row, spec) : null;
  }
}

/** The entity specs the config describes — for the runtime, the preview and the connect form. */
export function entitySpecsOf(endpoints: Record<string, RestEntity>): EntitySpec[] {
  return Object.entries(endpoints).map(([type, e]) => ({
    type,
    label: e.label ?? type,
    defaultOn: true,
    fields: Object.keys(e.attributes ?? {}).map((key) => ({ key, label: key })),
  }));
}

interface PageState {
  /** Page number (page), offset (offset), cursor value (cursor), next URL (link). */
  value: number | string | null;
  count: number;
  /** The value is a URL to GET as-is (link style, or a "cursor" that turned out to be one). */
  link?: boolean;
}

function pageStateOf(spec: RestEntity, cursor: ListCursor): PageState {
  const p = cursor.page as PageState | null;
  if (p && typeof p === 'object' && 'count' in p) return p;
  const style = spec.paging?.style ?? 'none';
  const start = spec.paging?.start;
  return {
    value: style === 'page' ? (start ?? 1) : style === 'offset' ? (start ?? 0) : null,
    count: 0,
  };
}

interface ListRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, unknown> | undefined;
}

/** The list call for one page: the fixed query / body, the incremental filter and the page parameter folded in. */
function listRequest(p: {
  cfg: RestRecordsConfig;
  spec: RestEntity;
  since: string | null;
  page: PageState;
}): ListRequest {
  const { spec, page } = p;
  const style = spec.paging?.style ?? 'none';
  if ((style === 'link' || page.link) && typeof page.value === 'string') {
    return { method: 'GET', url: resolveUrl(p.cfg.baseUrl, page.value) };
  }
  const method = spec.list.method ?? 'GET';
  const url = new URL(resolveUrl(p.cfg.baseUrl, spec.list.path));
  for (const [k, v] of Object.entries(spec.list.query ?? {})) url.searchParams.set(k, v);
  const body: Record<string, unknown> = { ...(spec.list.body ?? {}) };
  const put = (where: 'query' | 'body', key: string, value: string | number) => {
    if (where === 'body') body[key] = value;
    else url.searchParams.set(key, String(value));
  };
  const paramsIn: 'query' | 'body' = method === 'POST' ? 'body' : 'query';
  if (p.since && spec.incremental) {
    put(spec.incremental.in ?? paramsIn, spec.incremental.param, sinceValue(p.since, spec));
  }
  const paging = spec.paging;
  if (paging && style !== 'none') {
    if (paging.sizeParam) put(paramsIn, paging.sizeParam, paging.size ?? DEFAULT_PAGE_SIZE);
    if (paging.param && page.value !== null && page.value !== undefined) {
      put(paramsIn, paging.param, page.value);
    }
  }
  return {
    method,
    url: url.toString(),
    ...(method === 'POST' ? { body } : {}),
  };
}

function sinceValue(since: string, spec: RestEntity): string | number {
  const ms = Date.parse(since);
  switch (spec.incremental?.format ?? 'iso') {
    case 'epoch':
      return Math.floor(ms / 1000);
    case 'epoch_ms':
      return ms;
    case 'date':
      return since.slice(0, 10);
    default:
      return since;
  }
}

/** Where the walk goes after this page, or null when it ends. */
function nextPage(p: {
  spec: RestEntity;
  page: PageState;
  answer: unknown;
  rows: number;
}): PageState | null {
  const paging = p.spec.paging;
  const style = paging?.style ?? 'none';
  const count = p.page.count + 1;
  if (style === 'none' || p.rows === 0 || count >= MAX_PAGES) return null;
  const size = paging?.size ?? DEFAULT_PAGE_SIZE;
  switch (style) {
    case 'page':
      return p.rows < size ? null : { value: Number(p.page.value ?? 1) + 1, count };
    case 'offset':
      return p.rows < size ? null : { value: Number(p.page.value ?? 0) + p.rows, count };
    case 'cursor':
    case 'link': {
      const next = paging?.next ? valueAt(p.answer, paging.next) : undefined;
      if (typeof next !== 'string' && typeof next !== 'number') return null;
      if (String(next) === '' || String(next) === String(p.page.value ?? '')) return null;
      // A "cursor" that is a URL is a link — follow it rather than pass it as a parameter.
      const link = style === 'link' || /^https?:\/\//i.test(String(next));
      return { value: String(next), count, ...(link ? { link: true } : {}) };
    }
    default:
      return null;
  }
}

/** The rows in an answer: at the configured path, else the answer itself or its first array-valued property. */
export function rowsOf(answer: unknown, itemsPath: string | undefined): Record<string, unknown>[] {
  let at: unknown = itemsPath ? valueAt(answer, itemsPath) : answer;
  if (!Array.isArray(at) && !itemsPath && at && typeof at === 'object') {
    at = Object.values(at as Record<string, unknown>).find((v) => Array.isArray(v));
  }
  if (!Array.isArray(at)) return [];
  return at.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

/** One record out of a `get` answer: the answer itself when it carries the id, else the first object that does. */
function rowOf(answer: unknown, spec: RestEntity): Record<string, unknown> | null {
  if (!answer || typeof answer !== 'object') return null;
  const idPath = spec.fields.id;
  if (valueAt(answer, idPath) !== undefined) return answer as Record<string, unknown>;
  for (const v of Object.values(answer as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && valueAt(v, idPath) !== undefined) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

/** One row → the envelope, by the entity's field paths. */
export function toEnvelope(
  entity: string,
  row: Record<string, unknown>,
  spec: RestEntity,
): RecordEnvelope | null {
  const id = valueAt(row, spec.fields.id);
  if (id === undefined || id === null || id === '') return null;
  if (spec.deleted && isTruthy(valueAt(row, spec.deleted))) return null;
  const name =
    spec.fields.name
      .map((path) => stringOf(valueAt(row, path)))
      .filter((v) => v.length > 0)
      .join(' ') || `${entity} ${String(id)}`;
  const updatedRaw = spec.fields.updatedAt ? valueAt(row, spec.fields.updatedAt) : undefined;
  const relations = (spec.relations ?? []).flatMap((rel) => {
    const rowName = rel.name ? stringOf(valueAt(row, rel.name)) : '';
    return targetIdsOf(valueAt(row, rel.path)).map((target) => {
      const targetName = target.name || rowName;
      return {
        kind: rel.kind,
        targetType: rel.targetType,
        targetExternalId: target.id,
        ...(targetName ? { targetName } : {}),
      };
    });
  });
  return {
    entityType: entity,
    externalId: String(id),
    name,
    attributes: attributesOf(row, spec),
    relations,
    ...(typeof updatedRaw === 'string' || typeof updatedRaw === 'number'
      ? { updatedAt: isoOf(updatedRaw) }
      : {}),
  };
}

/** The configured attributes, else every top-level scalar the fields / relations do not already claim. */
function attributesOf(row: Record<string, unknown>, spec: RestEntity): Record<string, Scalar> {
  if (spec.attributes) {
    const picked: Record<string, Scalar | undefined> = {};
    for (const [key, path] of Object.entries(spec.attributes))
      picked[key] = scalarOf(valueAt(row, path));
    return scalars(picked);
  }
  const claimed = new Set<string>([
    spec.fields.id,
    ...spec.fields.name,
    ...(spec.fields.updatedAt ? [spec.fields.updatedAt] : []),
    ...(spec.deleted ? [spec.deleted] : []),
    ...(spec.relations ?? []).flatMap((r) => [r.path, ...(r.name ? [r.name] : [])]),
  ]);
  const out: Record<string, Scalar | undefined> = {};
  for (const [k, v] of Object.entries(row)) {
    if (claimed.has(k)) continue;
    const s = scalarOf(v);
    if (s !== undefined) out[k] = s;
  }
  return scalars(out);
}

/** Relation targets at a path: a scalar id, an object with `id` (and maybe a name), or an array of either. */
function targetIdsOf(v: unknown): Array<{ id: string; name?: string | undefined }> {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(targetIdsOf);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const id = o.id ?? o.ID ?? o.value;
    if (id === undefined || id === null || id === '') return [];
    const name = stringOf(o.name ?? o.title ?? o.label);
    return [{ id: String(id), ...(name ? { name } : {}) }];
  }
  if (typeof v === 'string' || typeof v === 'number') return [{ id: String(v) }];
  return [];
}

function scalarOf(v: unknown): Scalar | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return undefined;
}

function stringOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function isTruthy(v: unknown): boolean {
  if (typeof v === 'string') return !['', '0', 'false', 'n', 'no', 'N'].includes(v);
  return Boolean(v);
}

/** The value at a dotted path (`a.b.0.c`); undefined when any step is missing. */
export function valueAt(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const part of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) {
      const i = Number(part);
      v = Number.isInteger(i) ? v[i] : undefined;
    } else if (typeof v === 'object') {
      v = (v as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return v;
}

/** A path against the base: absolute URLs must stay on the base's origin. */
export function resolveUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const u = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\//, ''), base);
  if (u.origin !== base.origin) {
    throw new Error(`rest_records: ${u.origin} is not the connection's origin ${base.origin}`);
  }
  return u.toString();
}

function restConfigOf(ctx: ConnectorCtx): RestRecordsConfig {
  const parsed = RestRecordsConfigSchema.safeParse(configOf(ctx));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `rest_records: config ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

interface RestHttp {
  http: CloudHttp;
  /** Query-string auth: the parameter the credential rides on. */
  queryAuth: { name: string; value: string } | null;
  /** The credential, masked out of every error. */
  secret: string | null;
}

function httpOf(ctx: ConnectorCtx, cfg: RestRecordsConfig): RestHttp {
  const credential = ctx.connection.credential;
  const scheme = cfg.authScheme ?? 'bearer';
  const fixed = cfg.headers ?? {};
  const common = {
    private: cfg.allowPrivate === true,
    signal: ctx.signal,
  };
  if (!credential || scheme === 'none') {
    return {
      http: cloudHttp({ token: '', bearer: false, headers: fixed, ...common }),
      queryAuth: null,
      secret: null,
    };
  }
  if (scheme === 'basic') {
    return {
      http: cloudHttp({
        token: '',
        bearer: false,
        headers: { ...fixed, authorization: `Basic ${Buffer.from(credential).toString('base64')}` },
        ...common,
      }),
      queryAuth: null,
      secret: credential,
    };
  }
  if (scheme.startsWith('header:')) {
    return {
      http: cloudHttp({
        token: '',
        bearer: false,
        headers: { ...fixed, [scheme.slice('header:'.length)]: credential },
        ...common,
      }),
      queryAuth: null,
      secret: credential,
    };
  }
  if (scheme.startsWith('query:')) {
    return {
      http: cloudHttp({ token: '', bearer: false, headers: fixed, ...common }),
      queryAuth: { name: scheme.slice('query:'.length), value: credential },
      secret: credential,
    };
  }
  return {
    http: cloudHttp({ token: credential, headers: fixed, ...common }),
    queryAuth: null,
    secret: credential,
  };
}

/** One call, the query-string credential added last, the secret masked out of any error. */
async function call(h: RestHttp, req: ListRequest): Promise<unknown> {
  let url = req.url;
  if (h.queryAuth) {
    const u = new URL(url);
    u.searchParams.set(h.queryAuth.name, h.queryAuth.value);
    url = u.toString();
  }
  try {
    return req.method === 'POST'
      ? await h.http.postJson(url, req.body ?? {})
      : await h.http.getJson(url);
  } catch (e) {
    const err = e as Error & { status?: number };
    if (!h.secret) throw err;
    const masked = new Error(
      err.message.split(h.secret).join('***').split(encodeURIComponent(h.secret)).join('***'),
    ) as Error & { status?: number | undefined };
    if (err.status !== undefined) masked.status = err.status;
    throw masked;
  }
}
