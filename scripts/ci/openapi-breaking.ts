#!/usr/bin/env -S npx ts-node -T
/**
 * openapi-breaking — would a client written against the base branch's
 * contract break against this PR's?
 *
 *   ts-node -T scripts/ci/openapi-breaking.ts <base openapi.json> <head openapi.json>
 *   ts-node -T scripts/ci/openapi-breaking.ts --mcp <base golden> <head golden>
 *
 * The REST mode compares two docs/openapi.json documents; `--mcp`
 * compares two test/golden/mcp-tool-schemas.json goldens (the unit test
 * keeps the golden equal to the live surface, so a breaking MCP change
 * shows up here as a breaking golden diff). Exit 1 on a breaking change.
 *
 * REST changes reported as breaking:
 *   - a path or method removed, a success (2xx) response code removed;
 *   - a request body newly required, a request media type removed;
 *   - a parameter newly required (new, or optional → required), a query
 *     parameter removed (forbidNonWhitelisted turns it into a 400);
 *   - in request schemas and parameters: a property removed, a property
 *     newly required, a type narrowed, an enum value removed;
 *   - in success-response schemas: a property removed or no longer
 *     required, a type widened or changed.
 * The schema rules live in scripts/ci/schema-compat.ts.
 *
 * A deliberate break is allowed when the PR title is a breaking
 * Conventional Commit (`feat(api)!: …`): CI passes the title in the
 * PR_TITLE env var (never interpolated into the shell), the breaks are
 * printed as warnings and the exit is 0. release-please then cuts a major.
 *
 * No dependencies beyond node: it runs before anything else is trusted.
 */
import { readFileSync } from 'fs';
import { compareToolSchemas, resolvePointer, schemaBreaks } from './schema-compat';

type Json = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Follow a `$ref` in the document (components/parameters, requestBodies…). */
function deref(doc: unknown, v: unknown): unknown {
  let cur = v;
  for (let i = 0; i < 16 && isObj(cur) && typeof cur.$ref === 'string'; i++) {
    cur = resolvePointer(doc, cur.$ref);
  }
  return cur;
}

interface Param {
  in: string;
  name: string;
  required: boolean;
  schema: unknown;
}

function paramsOf(doc: unknown, pathItem: Json, op: Json): Map<string, Param> {
  const out = new Map<string, Param>();
  const all = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ];
  for (const raw of all) {
    const p = deref(doc, raw);
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
    // Operation-level parameters override path-level ones of the same key.
    out.set(`${p.in}:${p.name}`, {
      in: p.in,
      name: p.name,
      required: p.required === true || p.in === 'path',
      schema: p.schema,
    });
  }
  return out;
}

function contentOf(doc: unknown, holder: unknown): Map<string, unknown> {
  const h = deref(doc, holder);
  const out = new Map<string, unknown>();
  if (!isObj(h) || !isObj(h.content)) return out;
  for (const [type, media] of Object.entries(h.content)) {
    out.set(type, isObj(media) ? media.schema : undefined);
  }
  return out;
}

interface OpCtx {
  oldDoc: Json;
  newDoc: Json;
  label: string;
  out: string[];
}

function compareParams(
  oldParams: Map<string, Param>,
  newParams: Map<string, Param>,
  c: OpCtx,
): void {
  for (const [key, np] of newParams) {
    const op = oldParams.get(key);
    if (np.required && (!op || !op.required)) {
      c.out.push(`${c.label}: ${np.in} parameter '${np.name}' is newly required`);
    }
  }
  for (const [key, op] of oldParams) {
    const np = newParams.get(key);
    if (!np) {
      if (op.in === 'query') c.out.push(`${c.label}: query parameter '${op.name}' removed`);
      continue;
    }
    c.out.push(
      ...schemaBreaks({
        old: op.schema,
        new: np.schema,
        at: `${c.label} ${op.in} parameter '${op.name}'`,
        direction: 'request',
        oldRoot: c.oldDoc,
        newRoot: c.newDoc,
      }),
    );
  }
}

function compareRequestBody(oldOp: Json, newOp: Json, c: OpCtx): void {
  const oldBody = deref(c.oldDoc, oldOp.requestBody);
  const newBody = deref(c.newDoc, newOp.requestBody);
  const oldRequired = isObj(oldBody) && oldBody.required === true;
  const newRequired = isObj(newBody) && newBody.required === true;
  if (newRequired && !oldRequired) c.out.push(`${c.label}: request body is newly required`);
  const oldContent = contentOf(c.oldDoc, oldBody);
  const newContent = contentOf(c.newDoc, newBody);
  for (const [type, oldSchema] of oldContent) {
    if (!newContent.has(type)) {
      c.out.push(`${c.label}: request media type '${type}' removed`);
      continue;
    }
    c.out.push(
      ...schemaBreaks({
        old: oldSchema,
        new: newContent.get(type),
        at: `${c.label} request body`,
        direction: 'request',
        oldRoot: c.oldDoc,
        newRoot: c.newDoc,
      }),
    );
  }
}

function compareResponses(oldOp: Json, newOp: Json, c: OpCtx): void {
  const oldResponses = isObj(oldOp.responses) ? oldOp.responses : {};
  const newResponses = isObj(newOp.responses) ? newOp.responses : {};
  for (const [code, oldResp] of Object.entries(oldResponses)) {
    if (!code.startsWith('2')) continue;
    if (!(code in newResponses)) {
      c.out.push(`${c.label}: success response ${code} removed`);
      continue;
    }
    const oldContent = contentOf(c.oldDoc, oldResp);
    const newContent = contentOf(c.newDoc, newResponses[code]);
    for (const [type, oldSchema] of oldContent) {
      if (!newContent.has(type)) {
        c.out.push(`${c.label}: response ${code} media type '${type}' removed`);
        continue;
      }
      c.out.push(
        ...schemaBreaks({
          old: oldSchema,
          new: newContent.get(type),
          at: `${c.label} response ${code}`,
          direction: 'response',
          oldRoot: c.oldDoc,
          newRoot: c.newDoc,
        }),
      );
    }
  }
}

/** Every breaking change from `oldDoc` to `newDoc`, as readable lines. */
export function openApiBreaks(oldDoc: Json, newDoc: Json): string[] {
  const out: string[] = [];
  const oldPaths = isObj(oldDoc.paths) ? oldDoc.paths : {};
  const newPaths = isObj(newDoc.paths) ? newDoc.paths : {};
  for (const [path, rawOldItem] of Object.entries(oldPaths)) {
    const oldItem = deref(oldDoc, rawOldItem);
    if (!isObj(oldItem)) continue;
    const newItem = deref(newDoc, newPaths[path]);
    if (!isObj(newItem)) {
      out.push(`${path}: path removed`);
      continue;
    }
    for (const method of METHODS) {
      const oldOp = oldItem[method];
      if (!isObj(oldOp)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const newOp = newItem[method];
      if (!isObj(newOp)) {
        out.push(`${label}: method removed`);
        continue;
      }
      const c: OpCtx = { oldDoc, newDoc, label, out };
      compareParams(paramsOf(oldDoc, oldItem, oldOp), paramsOf(newDoc, newItem, newOp), c);
      compareRequestBody(oldOp, newOp, c);
      compareResponses(oldOp, newOp, c);
    }
  }
  return out;
}

/** A breaking Conventional Commit title: `type!:` or `type(scope)!:`. */
export function isBreakingTitle(title: string | undefined): boolean {
  return /^[a-z]+(\([^)]*\))?!:/i.test((title ?? '').trim());
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

/** CLI entry; returns the exit code. */
export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const mcp = argv[0] === '--mcp';
  const [basePath, headPath] = mcp ? argv.slice(1) : argv;
  if (!basePath || !headPath) {
    console.error('usage: openapi-breaking.ts [--mcp] <base.json> <head.json>');
    return 2;
  }
  const base = readJson(basePath);
  const head = readJson(headPath);
  const what = mcp ? 'MCP tool schemas' : 'REST API (docs/openapi.json)';
  const breaks = mcp ? compareToolSchemas(base, head).breaking : openApiBreaks(base, head);
  if (breaks.length === 0) {
    console.log(`${what}: no breaking changes against the base branch.`);
    return 0;
  }
  const list = breaks.map((b) => `  - ${b}`).join('\n');
  if (isBreakingTitle(env.PR_TITLE)) {
    console.log(
      `${what}: ${breaks.length} breaking change(s), allowed because the PR title marks a breaking release (\`!:\`):\n${list}`,
    );
    return 0;
  }
  console.error(
    `${what}: ${breaks.length} breaking change(s) against the base branch:\n${list}\n\n` +
      'Clients code against this contract. Prefer an additive change: add the new field or tool, ' +
      'mark the old one deprecated, keep it for at least one minor release (AGENTS.md, ' +
      '"Evolving data and contracts"). If the break is deliberate, give the PR a breaking ' +
      'Conventional Commit title (e.g. `feat(api)!: …`) and this check passes.',
  );
  return 1;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
