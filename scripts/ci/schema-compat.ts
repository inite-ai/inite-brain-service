/**
 * schema-compat — does a new JSON Schema still honour what the old one
 * promised? Pure; no I/O, no dependencies.
 *
 * Shared by the two contract gates: the MCP tool-schema golden
 * (test/mcp-tool-schemas.unit-spec.ts, and the CI base-vs-head run of
 * scripts/ci/openapi-breaking.ts --mcp) and the REST check over
 * docs/openapi.json (scripts/ci/openapi-breaking.ts).
 *
 * Direction decides what "breaking" means, because the client stands on
 * opposite sides of the two:
 *
 *   request  — the client SENDS it. Breaking = the new schema rejects
 *              something the old one accepted: a property removed (the
 *              REST ValidationPipe runs forbidNonWhitelisted, so an old
 *              SDK still sending it gets a 400; an MCP client loses the
 *              argument), a property newly required, a type narrowed, an
 *              enum value removed or an enum imposed where there was none.
 *   response — the client READS it. Breaking = the client no longer gets
 *              what it was promised: a property removed or no longer
 *              required, a type widened or changed. A new enum value in a
 *              response is not flagged (forward-compatible readers
 *              tolerate it; the common case is a new status).
 *
 * Deliberately NOT judged: numeric/length bounds, formats, patterns,
 * additionalProperties. They are rarely the shape an SDK is generated
 * from, and a check that cried wolf on every bound would be overridden by
 * habit. Every other difference is "drift": legal, but the golden must be
 * regenerated so it stays exact.
 *
 * Unions (anyOf/oneOf) are flattened: types and enum values are the union
 * of the branches, object properties are merged (first branch wins per
 * name), required is what every object branch requires. allOf merges. A
 * local `$ref` ("#/…") resolves against the document root it came from.
 */

export type Direction = 'request' | 'response';

type Json = Record<string, unknown>;

interface Shape {
  /** null = no type constraint (accepts anything). */
  types: Set<string> | null;
  props: Map<string, unknown>;
  required: Set<string>;
  /** null = no enum constraint. */
  enumValues: unknown[] | null;
  items: unknown;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Resolve a local JSON pointer ("#/components/schemas/X") against root. */
export function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  const parts = ref
    .slice(1)
    .split('/')
    .filter((p) => p.length > 0)
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const p of parts) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const MAX_DEPTH = 32;

function deref(schema: unknown, root: unknown): unknown {
  let cur = schema;
  for (let i = 0; i < MAX_DEPTH && isObj(cur) && typeof cur.$ref === 'string'; i++) {
    cur = resolvePointer(root, cur.$ref);
  }
  return cur;
}

function typesOf(s: Json): Set<string> | null {
  const t = s.type;
  const out = new Set<string>();
  if (typeof t === 'string') {
    out.add(t);
  } else if (Array.isArray(t)) {
    for (const x of t) if (typeof x === 'string') out.add(x);
  } else {
    return null;
  }
  if (s.nullable === true) out.add('null');
  return out;
}

function enumOf(s: Json): unknown[] | null {
  if (Array.isArray(s.enum)) return s.enum as unknown[];
  if ('const' in s) return [s.const];
  return null;
}

function emptyShape(): Shape {
  return { types: null, props: new Map(), required: new Set(), enumValues: null, items: undefined };
}

function unionTypes(a: Set<string> | null, b: Set<string> | null): Set<string> | null {
  if (a === null || b === null) return null;
  return new Set([...a, ...b]);
}

function normalize(schema: unknown, root: unknown, depth = 0): Shape {
  const s = deref(schema, root);
  const shape = emptyShape();
  if (!isObj(s) || depth > MAX_DEPTH) return shape;
  shape.types = typesOf(s);
  shape.enumValues = enumOf(s);
  if (isObj(s.properties)) {
    for (const [k, v] of Object.entries(s.properties)) shape.props.set(k, v);
  }
  if (Array.isArray(s.required)) {
    for (const r of s.required) if (typeof r === 'string') shape.required.add(r);
  }
  if (s.items !== undefined && !Array.isArray(s.items)) shape.items = s.items;

  for (const key of ['allOf'] as const) {
    const parts = s[key];
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const n = normalize(p, root, depth + 1);
      if (shape.types === null) shape.types = n.types;
      else if (n.types !== null)
        shape.types = new Set([...shape.types].filter((t) => n.types!.has(t)));
      for (const [k, v] of n.props) if (!shape.props.has(k)) shape.props.set(k, v);
      for (const r of n.required) shape.required.add(r);
      shape.enumValues ??= n.enumValues;
      shape.items ??= n.items;
    }
  }

  const branches = [
    ...(Array.isArray(s.anyOf) ? s.anyOf : []),
    ...(Array.isArray(s.oneOf) ? s.oneOf : []),
  ];
  if (branches.length > 0) {
    const ns = branches.map((b) => normalize(b, root, depth + 1));
    // An own `type` alongside the union is a constraint on top of it; a
    // bare union takes its branches' types.
    if (typesOf(s) === null) {
      let t: Set<string> | null = new Set();
      for (const n of ns) t = unionTypes(t, n.types);
      shape.types = t;
    }
    // A bare `{type: 'null'}` branch (zod's .nullable()) is the enum [null],
    // so a nullable enum is still an enum.
    const branchEnum = (n: Shape): unknown[] | null =>
      n.enumValues ?? (n.types?.size === 1 && n.types.has('null') ? [null] : null);
    if (shape.enumValues === null && ns.every((n) => branchEnum(n) !== null)) {
      shape.enumValues = ns.flatMap((n) => branchEnum(n) ?? []);
    }
    const objectBranches = ns.filter((n) => n.props.size > 0);
    for (const n of objectBranches) {
      for (const [k, v] of n.props) if (!shape.props.has(k)) shape.props.set(k, v);
    }
    if (objectBranches.length > 0) {
      const first = objectBranches[0]!;
      for (const r of first.required) {
        if (objectBranches.every((n) => n.required.has(r))) shape.required.add(r);
      }
    }
    for (const n of ns) shape.items ??= n.items;
  }
  return shape;
}

const fmt = (t: Set<string> | null): string => (t === null ? 'any' : [...t].sort().join('|'));

/** Is a value of JSON type `t` accepted by a schema whose types are `by`? */
function accepts(by: Set<string> | null, t: string): boolean {
  if (by === null) return true;
  return by.has(t) || (t === 'integer' && by.has('number'));
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface CompareInput {
  old: unknown;
  new: unknown;
  /** Where this schema sits, for the messages ("POST /v1/search request body"). */
  at: string;
  direction: Direction;
  /** Documents the old / new `$ref`s resolve against (default: the schema itself). */
  oldRoot?: unknown;
  newRoot?: unknown;
}

/** Every breaking difference between two schemas, as readable lines. */
export function schemaBreaks(input: CompareInput): string[] {
  const out: string[] = [];
  const oldRoot = input.oldRoot ?? input.old;
  const newRoot = input.newRoot ?? input.new;
  walk(
    { o: input.old, n: input.new, at: input.at },
    { dir: input.direction, oldRoot, newRoot, out, seen: new Set(), depth: 0 },
  );
  return out;
}

interface WalkCtx {
  dir: Direction;
  oldRoot: unknown;
  newRoot: unknown;
  out: string[];
  /** $ref pairs already compared — recursive schemas terminate. */
  seen: Set<string>;
  depth: number;
}

function walk(pos: { o: unknown; n: unknown; at: string }, ctx: WalkCtx): void {
  if (ctx.depth > MAX_DEPTH) return;
  const oRef = isObj(pos.o) && typeof pos.o.$ref === 'string' ? pos.o.$ref : '';
  const nRef = isObj(pos.n) && typeof pos.n.$ref === 'string' ? pos.n.$ref : '';
  if (oRef || nRef) {
    const key = `${oRef}|${nRef}`;
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }
  const o = normalize(pos.o, ctx.oldRoot);
  const n = normalize(pos.n, ctx.newRoot);
  const { at } = pos;
  const { dir, out } = ctx;

  // Types.
  if (dir === 'request') {
    if (o.types === null && n.types !== null) {
      out.push(`${at}: type narrowed from any to ${fmt(n.types)}`);
    } else if (o.types !== null && [...o.types].some((t) => !accepts(n.types, t))) {
      out.push(`${at}: type narrowed from ${fmt(o.types)} to ${fmt(n.types)}`);
    }
  } else if (n.types === null && o.types !== null) {
    out.push(`${at}: type widened from ${fmt(o.types)} to any`);
  } else if (n.types !== null && [...n.types].some((t) => !accepts(o.types, t))) {
    out.push(`${at}: type changed from ${fmt(o.types)} to ${fmt(n.types)}`);
  }

  // Enums (request side only; see the docblock).
  if (dir === 'request') {
    if (o.enumValues === null && n.enumValues !== null) {
      out.push(`${at}: values restricted to enum ${JSON.stringify(n.enumValues)}`);
    } else if (o.enumValues !== null && n.enumValues !== null) {
      const newVals = n.enumValues;
      for (const v of o.enumValues) {
        // A lost null is a type narrowing, reported as one above.
        if (v !== null && !newVals.some((x) => sameValue(x, v))) {
          out.push(`${at}: enum value ${JSON.stringify(v)} removed`);
        }
      }
    }
  }

  // Properties.
  for (const [name, oProp] of o.props) {
    const nProp = n.props.get(name);
    if (nProp === undefined) {
      out.push(`${at}: property '${name}' removed`);
      continue;
    }
    walk({ o: oProp, n: nProp, at: `${at}.${name}` }, { ...ctx, depth: ctx.depth + 1 });
  }

  // Required.
  if (dir === 'request') {
    for (const r of n.required) {
      if (!o.required.has(r)) out.push(`${at}: property '${r}' is newly required`);
    }
  } else {
    for (const r of o.required) {
      if (n.props.has(r) && !n.required.has(r)) {
        out.push(`${at}: property '${r}' is no longer always present`);
      }
    }
  }

  // Array items.
  if (o.items !== undefined && n.items !== undefined) {
    walk({ o: o.items, n: n.items, at: `${at}[]` }, { ...ctx, depth: ctx.depth + 1 });
  }
}

/** Order-insensitive structural equality of two JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && jsonEqual(a[k], b[k]));
}

export interface ToolSchemaDelta {
  /** Changes an existing client can trip on. */
  breaking: string[];
  /** Legal changes the golden has not caught up with (new tool, new optional property, wording). */
  drift: string[];
}

/**
 * Compare a tool-name → inputSchema map (the golden) with the live one.
 * A tool missing from `live` is breaking whether it was removed or
 * renamed: either way a client calling the old name gets "unknown tool".
 */
export function compareToolSchemas(
  golden: Record<string, unknown>,
  live: Record<string, unknown>,
): ToolSchemaDelta {
  const breaking: string[] = [];
  const drift: string[] = [];
  for (const [name, schema] of Object.entries(golden)) {
    if (!(name in live)) {
      breaking.push(`tool '${name}' removed or renamed`);
      continue;
    }
    const liveSchema = live[name];
    const breaks = schemaBreaks({ old: schema, new: liveSchema, at: name, direction: 'request' });
    breaking.push(...breaks);
    if (breaks.length === 0 && !jsonEqual(schema, liveSchema)) {
      drift.push(`tool '${name}': input schema changed (non-breaking)`);
    }
  }
  for (const name of Object.keys(live)) {
    if (!(name in golden)) drift.push(`tool '${name}' added`);
  }
  return { breaking, drift };
}
