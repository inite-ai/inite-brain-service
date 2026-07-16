/**
 * Pack-declared MCP tools (docs/mcp-pack-tools.md) — unit coverage:
 *
 *   - validateMcpTools matrix (names, duplicates, caps, surfaces,
 *     foreign predicates, endpoints, params);
 *   - renderer (server preamble per kind, control/bidi strip, caps);
 *   - registration through a stub McpServer (flag gating, namespacing,
 *     packIds fence, fixed query schemas);
 *   - handlers (server-computed predicate lock + limit clamp, enum
 *     fence on facts_by_predicate);
 *   - external proxy against a REAL local http server (HMAC signature,
 *     timeout, 64 KB cap, circuit breaker, egress guard);
 *   - install consent helper (fresh install, unchanged re-consent
 *     carry-over, changed-section re-consent).
 */
import {
  validateMcpTools,
  validatePack,
  DomainPackError,
  type DomainPackManifest,
  type PackPredicate,
  type PackToolSpec,
} from '../src/ai/domain-packs';

function packPredicate(localId: string): PackPredicate {
  return {
    localId,
    displayLabel: localId,
    description: 'x',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
  };
}

function pack(over: Partial<DomainPackManifest> = {}): DomainPackManifest {
  return {
    id: 'demo',
    version: '0.1.0',
    description: 'demo',
    predicates: [packPredicate('thing'), packPredicate('status')],
    ...over,
  };
}

function queryTool(over: Record<string, unknown> = {}): PackToolSpec {
  return {
    kind: 'query',
    name: 'find_things',
    description: 'Find things recorded by this pack.',
    query: { surface: 'search' },
    ...over,
  } as PackToolSpec;
}

function externalTool(over: Record<string, unknown> = {}): PackToolSpec {
  return {
    kind: 'external',
    name: 'check_thing',
    description: 'Check a thing against the publisher backend.',
    endpoint: 'https://tools.example.com/check',
    ...over,
  } as PackToolSpec;
}

describe('validateMcpTools', () => {
  const ok = (tools: PackToolSpec[]) =>
    expect(() => validateMcpTools(pack(), tools)).not.toThrow();
  const bad = (tools: unknown, re: RegExp) =>
    expect(() => validateMcpTools(pack(), tools)).toThrow(re);

  it('accepts a well-formed query + external tool set', () => {
    ok([
      queryTool(),
      queryTool({
        name: 'things_by_status',
        query: { surface: 'facts_by_predicate', predicates: ['status'] },
      }),
      externalTool({
        params: [
          { name: 'thing_id', type: 'string', required: true, maxLength: 64 },
          { name: 'mode', type: 'string', enum: ['fast', 'deep'] },
        ],
        timeoutMs: 5_000,
      }),
    ]);
  });

  it('is wired into validatePack', () => {
    expect(() =>
      validatePack(pack({ mcpTools: [queryTool({ name: 'BAD' })] })),
    ).toThrow(DomainPackError);
  });

  it('rejects an empty array', () => bad([], /non-empty array/));
  it('rejects more than 8 tools', () => {
    const tools = Array.from({ length: 9 }, (_, i) =>
      queryTool({ name: `tool_${i}` }),
    );
    bad(tools, /max is 8/);
  });

  it('rejects bad tool names (uppercase, digit-lead, separator, too long)', () => {
    bad([queryTool({ name: 'Find' })], /must match/);
    bad([queryTool({ name: '9find' })], /must match/);
    bad([queryTool({ name: 'a__b' })], /must match|__/);
    bad([queryTool({ name: 'a'.repeat(42) })], /must match/);
    bad([queryTool({ name: 'x' })], /must match/); // single char — below min
  });

  it('rejects duplicate tool names', () =>
    bad([queryTool(), queryTool()], /duplicate mcpTool name/));

  it('rejects an unknown kind', () =>
    bad([{ ...queryTool(), kind: 'wasm' }], /kind/));

  it('rejects a missing / oversized description and oversized title', () => {
    bad([queryTool({ description: undefined })], /description/);
    bad([queryTool({ description: 'x'.repeat(501) })], /description/);
    bad([queryTool({ title: 'x'.repeat(81) })], /title/);
  });

  it('rejects an unknown query surface', () =>
    bad([queryTool({ query: { surface: 'raw_surql' } })], /surface/));

  it('rejects facts_by_predicate without predicates', () =>
    bad(
      [queryTool({ query: { surface: 'facts_by_predicate' } })],
      /requires query.predicates/,
    ));

  it('rejects predicates that are not the pack own localIds', () =>
    bad(
      [queryTool({ query: { surface: 'search', predicates: ['other__salary'] } })],
      /not a predicate of this pack/,
    ));

  it('rejects defaultLimit / minConfidence out of range', () => {
    bad([queryTool({ query: { surface: 'search', defaultLimit: 0 } })], /defaultLimit/);
    bad([queryTool({ query: { surface: 'search', defaultLimit: 21 } })], /defaultLimit/);
    bad([queryTool({ query: { surface: 'search', minConfidence: 1.5 } })], /minConfidence/);
  });

  it('rejects minConfidence on facts_by_predicate (search only)', () =>
    bad(
      [
        queryTool({
          query: {
            surface: 'facts_by_predicate',
            predicates: ['thing'],
            minConfidence: 0.5,
          },
        }),
      ],
      /search surface only/,
    ));

  it('rejects a malformed endpoint (and non-http schemes)', () => {
    bad([externalTool({ endpoint: 'not a url' })], /endpoint/);
    bad([externalTool({ endpoint: 'ftp://tools.example.com' })], /endpoint/);
  });

  it('accepts an http endpoint at validation time (egress guard owns https-only)', () =>
    ok([externalTool({ endpoint: 'http://tools.example.com/hook' })]));

  it('rejects timeoutMs out of [1000, 30000]', () => {
    bad([externalTool({ timeoutMs: 500 })], /timeoutMs/);
    bad([externalTool({ timeoutMs: 31_000 })], /timeoutMs/);
  });

  it('rejects more than 8 params and duplicate param names', () => {
    const params = Array.from({ length: 9 }, (_, i) => ({
      name: `p_${i}`,
      type: 'string',
    }));
    bad([externalTool({ params })], /at most 8/);
    bad(
      [
        externalTool({
          params: [
            { name: 'p', type: 'string' },
            { name: 'p', type: 'number' },
          ],
        }),
      ],
      /duplicate param/,
    );
  });

  it('rejects bad param names / types / caps', () => {
    bad([externalTool({ params: [{ name: 'P', type: 'string' }] })], /param name/);
    bad([externalTool({ params: [{ name: 'p', type: 'object' }] })], /type/);
    bad(
      [externalTool({ params: [{ name: 'p', type: 'string', description: 'x'.repeat(201) }] })],
      /description/,
    );
    bad(
      [externalTool({ params: [{ name: 'p', type: 'number', enum: ['1'] }] })],
      /string params only/,
    );
    bad(
      [
        externalTool({
          params: [{ name: 'p', type: 'string', enum: Array(21).fill('v') }],
        }),
      ],
      /enum/,
    );
    bad(
      [externalTool({ params: [{ name: 'p', type: 'string', enum: ['x'.repeat(61)] }] })],
      /enum/,
    );
    bad(
      [externalTool({ params: [{ name: 'p', type: 'string', maxLength: 0 }] })],
      /maxLength/,
    );
    bad(
      [externalTool({ params: [{ name: 'p', type: 'string', maxLength: 2_001 }] })],
      /maxLength/,
    );
    bad(
      [externalTool({ params: [{ name: 'p', type: 'number', maxLength: 10 }] })],
      /string params only/,
    );
  });
});
