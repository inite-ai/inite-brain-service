import { parse as parseYaml } from 'yaml';

/**
 * A bounded reading of an OpenAPI 3.x document for the mapping
 * assistant (docs/roadmap/crm-sources-2026-09.md § 4.3): the read-only
 * LIST-shaped operations — a GET (or a POST whose name says search /
 * list / query) whose 200 answer is an array of objects, or an object
 * that holds one (`data`, `result.items`, `_embedded.<x>`) — with their
 * parameters and the item's property names and types. `$ref`s are
 * resolved inside the document to a bounded depth; nothing outside the
 * document is ever fetched from here. Everything else in the spec
 * (writes, auth flows, examples, descriptions beyond one line) is
 * deliberately not read: the assistant proposes a bounded config, and
 * the preview — not the spec — is the truth.
 */

export interface ParamDigest {
  name: string;
  /** `body` = a top-level property of a POST search's JSON request body. */
  in: 'query' | 'path' | 'header' | 'body';
  type: string | null;
  required: boolean;
}

export interface PropertyDigest {
  name: string;
  type: string | null;
}

export interface OperationDigest {
  method: 'GET' | 'POST';
  path: string;
  operationId: string | null;
  summary: string | null;
  params: ParamDigest[];
  /** Dotted path to the rows inside the answer; '' = the answer is the array. */
  itemsPath: string;
  properties: PropertyDigest[];
  /** The answer object's own top-level keys when the rows are wrapped (where a next cursor would sit). */
  answerKeys: string[];
}

export interface ApiDigest {
  title: string | null;
  /** The document's own server URLs (the first is the usual base). */
  servers: string[];
  operations: OperationDigest[];
  /** Every path the document declares (a `get` by id shows here, not in `operations`). */
  paths: string[];
}

const MAX_OPERATIONS = 80;
const MAX_PROPERTIES = 60;
const MAX_PARAMS = 40;
const REF_DEPTH = 8;
const WRAPPER_DEPTH = 3;
const SEARCH_VERB = /search|list|query|find|filter/i;

type Json = Record<string, unknown>;

/** JSON or YAML text → the document object; throws by name when it is neither. */
export function parseOpenApiText(text: string): Json {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('the OpenAPI document is empty');
  try {
    if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Json;
  } catch {
    // fall through to YAML (a superset of JSON) for the error message
  }
  let doc: unknown;
  try {
    doc = parseYaml(trimmed, { maxAliasCount: 100 });
  } catch (e) {
    throw new Error(`the OpenAPI document does not parse: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('the OpenAPI document is not an object');
  }
  return doc as Json;
}

/** The list-shaped read operations of a document. */
export function digestOpenApi(doc: Json): ApiDigest {
  const info = doc.info as Json | undefined;
  const servers = Array.isArray(doc.servers)
    ? (doc.servers as Json[])
        .map((s) => (typeof s.url === 'string' ? s.url : ''))
        .filter((u) => u.length > 0)
    : [];
  const paths = (doc.paths ?? {}) as Record<string, Json>;
  const resolver = new RefResolver(doc);
  const operations: OperationDigest[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ['get', 'post'] as const) {
      const digested = digestOperation({ path, item, method, resolver });
      if (digested) operations.push(digested);
      if (operations.length >= MAX_OPERATIONS) break;
    }
    if (operations.length >= MAX_OPERATIONS) break;
  }
  return {
    title: typeof info?.title === 'string' ? info.title : null,
    servers,
    operations,
    paths: Object.keys(paths).slice(0, 2000),
  };
}

/** One path item's GET (or search-shaped POST) as a list operation, or null when it is not one. */
function digestOperation(p: {
  path: string;
  item: Json;
  method: 'get' | 'post';
  resolver: RefResolver;
}): OperationDigest | null {
  const op = p.item[p.method] as Json | undefined;
  if (!op || typeof op !== 'object') return null;
  const operationId = typeof op.operationId === 'string' ? op.operationId : null;
  if (p.method === 'post' && !SEARCH_VERB.test(`${operationId ?? ''} ${p.path}`)) return null;
  const shape = listShapeOf(op, p.resolver);
  if (!shape) return null;
  const shared = Array.isArray(p.item.parameters) ? (p.item.parameters as unknown[]) : [];
  const own = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
  return {
    method: p.method === 'get' ? 'GET' : 'POST',
    path: p.path,
    operationId,
    summary: typeof op.summary === 'string' ? op.summary.slice(0, 160) : null,
    params: [...paramsOf([...shared, ...own], p.resolver), ...bodyParamsOf(op, p.resolver)],
    itemsPath: shape.itemsPath,
    properties: shape.properties,
    answerKeys: shape.answerKeys,
  };
}

class RefResolver {
  private readonly seen = new Set<string>();
  constructor(private readonly doc: Json) {}

  /** The schema behind a `$ref` (local only), or the node itself; cycles and depth answer null. */
  resolve(node: unknown, depth = 0): Json | null {
    if (!node || typeof node !== 'object' || depth > REF_DEPTH) return null;
    const n = node as Json;
    const ref = n.$ref;
    if (typeof ref !== 'string') return n;
    if (!ref.startsWith('#/')) return null;
    if (this.seen.has(ref)) return null;
    this.seen.add(ref);
    try {
      let at: unknown = this.doc;
      for (const part of ref.slice(2).split('/')) {
        if (!at || typeof at !== 'object') return null;
        at = (at as Json)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      return this.resolve(at, depth + 1);
    } finally {
      this.seen.delete(ref);
    }
  }
}

function paramsOf(raw: unknown[], resolver: RefResolver): ParamDigest[] {
  const out: ParamDigest[] = [];
  for (const p of raw) {
    const param = resolver.resolve(p);
    if (!param || typeof param.name !== 'string') continue;
    const where = param.in;
    if (where !== 'query' && where !== 'path' && where !== 'header') continue;
    const schema = resolver.resolve(param.schema);
    out.push({
      name: param.name,
      in: where,
      type: typeof schema?.type === 'string' ? schema.type : null,
      required: param.required === true,
    });
    if (out.length >= MAX_PARAMS) break;
  }
  return out;
}

/** A POST search's JSON body properties as parameters (`in: 'body'`). */
function bodyParamsOf(op: Json, resolver: RefResolver): ParamDigest[] {
  const body = resolver.resolve(op.requestBody);
  const content = body?.content as Json | undefined;
  const media = content?.['application/json'] as Json | undefined;
  const schema = resolver.resolve(media?.schema);
  if (!schema) return [];
  const merged = composed(schema, resolver);
  const props = (merged.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(merged.required) ? (merged.required as string[]) : [];
  const out: ParamDigest[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = resolver.resolve(raw);
    out.push({
      name,
      in: 'body',
      type: typeof p?.type === 'string' ? p.type : null,
      required: required.includes(name),
    });
    if (out.length >= MAX_PARAMS) break;
  }
  return out;
}

/** The 200 JSON answer of an operation as a list: where the rows are and what one row carries. */
interface ListShape {
  itemsPath: string;
  properties: PropertyDigest[];
  answerKeys: string[];
}

function listShapeOf(op: Json, resolver: RefResolver): ListShape | null {
  const responses = op.responses as Json | undefined;
  const ok = resolver.resolve(responses?.['200'] ?? responses?.['2XX'] ?? responses?.default);
  const content = ok?.content as Json | undefined;
  const media =
    (content?.['application/json'] as Json | undefined) ??
    (content ? (Object.values(content)[0] as Json | undefined) : undefined);
  const schema = resolver.resolve(media?.schema);
  if (!schema) return null;
  const found = findArray({ schema, resolver, prefix: '', depth: 0 });
  if (!found) return null;
  const top = composed(schema, resolver);
  const answerKeys = found.itemsPath ? Object.keys((top.properties as Json) ?? {}) : [];
  return { ...found, answerKeys };
}

function findArray(p: {
  schema: Json;
  resolver: RefResolver;
  prefix: string;
  depth: number;
}): { itemsPath: string; properties: PropertyDigest[] } | null {
  const { resolver, prefix, depth } = p;
  const merged = composed(p.schema, resolver);
  if (merged.type === 'array' || merged.items) {
    const items = resolver.resolve(merged.items);
    const props = items ? propertiesOf(items, resolver) : [];
    return props.length ? { itemsPath: prefix, properties: props } : null;
  }
  if (depth >= WRAPPER_DEPTH) return null;
  const props = (merged.properties ?? {}) as Record<string, unknown>;
  // Prefer the conventional wrappers, then any array-valued property, then one level deeper.
  const order = Object.keys(props).sort(
    (a, b) => wrapperRank(a) - wrapperRank(b) || a.localeCompare(b),
  );
  const descend = (key: string, want: 'array' | 'object') => {
    const child = resolver.resolve(props[key]);
    if (!child) return null;
    const c = composed(child, resolver);
    const isArray = c.type === 'array' || Boolean(c.items);
    const isObject = c.type === 'object' || Boolean(c.properties);
    if (want === 'array' ? !isArray : !isObject) return null;
    return findArray({
      schema: child,
      resolver,
      prefix: prefix ? `${prefix}.${key}` : key,
      depth: depth + 1,
    });
  };
  for (const key of order) {
    const found = descend(key, 'array');
    if (found) return found;
  }
  for (const key of order) {
    const found = descend(key, 'object');
    if (found) return found;
  }
  return null;
}

const WRAPPERS = [
  'data',
  'items',
  'results',
  'result',
  'records',
  'rows',
  'list',
  '_embedded',
  'value',
];

function wrapperRank(key: string): number {
  const i = WRAPPERS.indexOf(key);
  return i === -1 ? WRAPPERS.length : i;
}

/** allOf / oneOf / anyOf folded into one schema (first alternative wins), refs resolved. */
function composed(schema: Json, resolver: RefResolver): Json {
  const parts: Json[] = [];
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const alts = schema[key];
    if (!Array.isArray(alts)) continue;
    for (const alt of key === 'allOf' ? alts : alts.slice(0, 1)) {
      const r = resolver.resolve(alt);
      if (r) parts.push(composed(r, resolver));
    }
  }
  if (!parts.length) return schema;
  const properties: Record<string, unknown> = { ...((schema.properties as Json) ?? {}) };
  let type = schema.type;
  let items = schema.items;
  for (const p of parts) {
    Object.assign(properties, (p.properties as Json) ?? {});
    type ??= p.type;
    items ??= p.items;
  }
  return { ...schema, ...(type ? { type } : {}), ...(items ? { items } : {}), properties };
}

function propertiesOf(schema: Json, resolver: RefResolver): PropertyDigest[] {
  const merged = composed(schema, resolver);
  const props = (merged.properties ?? {}) as Record<string, unknown>;
  const out: PropertyDigest[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = resolver.resolve(raw);
    const type = typeof p?.type === 'string' ? p.type : p?.properties ? 'object' : null;
    out.push({ name, type });
    if (out.length >= MAX_PROPERTIES) break;
  }
  return out;
}
