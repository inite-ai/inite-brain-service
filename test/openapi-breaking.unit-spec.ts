/**
 * The REST breaking-change check CI runs on every PR: base branch's
 * docs/openapi.json vs the PR's (scripts/ci/openapi-breaking.ts). Fixtures
 * in test/fixtures/openapi-breaking/: head.json makes one of each breaking
 * change to base.json, plus additive ones that must stay quiet.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isBreakingTitle, openApiBreaks, run } from '../scripts/ci/openapi-breaking';

type Json = Record<string, unknown>;

const FIXTURES = join(__dirname, 'fixtures', 'openapi-breaking');
const BASE_PATH = join(FIXTURES, 'base.json');
const HEAD_PATH = join(FIXTURES, 'head.json');
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Json;

describe('openApiBreaks', () => {
  it('a document against itself has no breaks', () => {
    expect(openApiBreaks(load(BASE_PATH), load(BASE_PATH))).toEqual([]);
  });

  it('the repo’s own contract against itself has no breaks', () => {
    const doc = load(join(__dirname, '..', 'docs', 'openapi.json'));
    expect(openApiBreaks(doc, structuredClone(doc))).toEqual([]);
  });

  it('reports each kind of breaking change, once, where it happened', () => {
    expect(openApiBreaks(load(BASE_PATH), load(HEAD_PATH)).sort()).toEqual(
      [
        // A removed path, a removed method.
        '/v1/legacy: path removed',
        'DELETE /v1/things/{id}: method removed',
        // A new required parameter.
        "GET /v1/things: query parameter 'region' is newly required",
        // A removed response property, wherever the schema is returned.
        "GET /v1/things response 200.items[]: property 'note' removed",
        "POST /v1/things response 201: property 'note' removed",
        "GET /v1/things/{id} response 200: property 'note' removed",
        // A new required request property, a narrowed type, a removed enum value.
        "POST /v1/things request body: property 'weight' is newly required",
        'POST /v1/things request body.weight: type narrowed from number to integer',
        'POST /v1/things request body.kind: enum value "b" removed',
      ].sort(),
    );
  });

  it('stays quiet on additive changes', () => {
    const base = load(BASE_PATH);
    const head = structuredClone(base) as Json & { paths: Json; components: Json };
    const paths = head.paths as Record<string, Record<string, Json>>;
    // A new path, a new optional parameter, a new optional request
    // property, a new response property, a new response enum value.
    paths['/v1/new'] = { get: { responses: { '200': { description: 'ok' } } } };
    (paths['/v1/things']!.get!.parameters as unknown[]).push({
      name: 'sort',
      in: 'query',
      schema: { type: 'string' },
    });
    const schemas = (head.components as { schemas: Record<string, Json> }).schemas;
    (schemas.NewThing!.properties as Json).color = { type: 'string' };
    (schemas.Thing!.properties as Json).extra = { type: 'string' };
    ((schemas.Thing!.properties as Json).kind as Json).enum = ['a', 'b', 'c'];
    expect(openApiBreaks(base, head)).toEqual([]);
  });

  it('a removed query parameter is breaking (forbidNonWhitelisted answers it with a 400)', () => {
    const base = load(BASE_PATH);
    const head = structuredClone(base) as Json;
    const get = (head.paths as Record<string, Record<string, Json>>)['/v1/things']!.get!;
    get.parameters = (get.parameters as Json[]).filter((p) => p.name !== 'cursor');
    expect(openApiBreaks(base, head)).toEqual(["GET /v1/things: query parameter 'cursor' removed"]);
  });

  it('a body that becomes required is breaking', () => {
    const base = load(BASE_PATH);
    const head = structuredClone(base) as Json;
    const things = (head.paths as Record<string, Record<string, Json>>)['/v1/things']!;
    things.put = { requestBody: { required: true, content: {} }, responses: {} };
    const before = structuredClone(base) as Json;
    (before.paths as Record<string, Record<string, Json>>)['/v1/things']!.put = { responses: {} };
    expect(openApiBreaks(before, head)).toEqual(['PUT /v1/things: request body is newly required']);
  });
});

describe('isBreakingTitle', () => {
  it.each([
    ['feat(api)!: drop the legacy route', true],
    ['refactor!: rename', true],
    ['feat(api): add a field', false],
    ['fix: mention !: in passing', false],
    ['', false],
  ])('%s → %s', (title, expected) => {
    expect(isBreakingTitle(title)).toBe(expected);
  });
});

describe('run (the CLI)', () => {
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
  });

  it('exits 0 with no breaks', () => {
    expect(run([BASE_PATH, BASE_PATH], {})).toBe(0);
  });

  it('exits 1 on a break and says how to proceed', () => {
    expect(run([BASE_PATH, HEAD_PATH], { PR_TITLE: 'feat(api): tidy' })).toBe(1);
    const message = String(err.mock.calls[0]?.[0]);
    expect(message).toContain('/v1/legacy: path removed');
    expect(message).toContain('!: ');
    expect(message).toContain('deprecated');
  });

  it('lets a deliberate break through under a `!:` title', () => {
    expect(run([BASE_PATH, HEAD_PATH], { PR_TITLE: 'feat(api)!: drop legacy' })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('allowed');
  });

  it('compares MCP goldens with --mcp', () => {
    const golden = join(__dirname, 'golden', 'mcp-tool-schemas.json');
    expect(run(['--mcp', golden, golden], {})).toBe(0);
  });

  it('rejects a malformed invocation', () => {
    expect(run(['only-one.json'], {})).toBe(2);
  });
});
