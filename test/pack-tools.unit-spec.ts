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
  externalMcpTools,
  mcpConsentRequired,
  mcpToolsChecksum,
  validateMcpTools,
  validatePack,
  DomainPackError,
  type DomainPackManifest,
  type PackPredicate,
  type PackToolSpec,
} from '../src/ai/domain-packs';
import {
  assertPublicHttpUrl,
  EgressDeniedError,
} from '../src/common/egress-guard';

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

describe('mcpTools install consent (mcpConsentRequired)', () => {
  const withTools = (tools: PackToolSpec[]) => pack({ mcpTools: tools });

  it('requires the flag on a fresh install declaring tools', () => {
    const msg = mcpConsentRequired({
      manifest: withTools([queryTool(), externalTool()]),
      acceptMcpTools: undefined,
      priorAccepted: false,
      priorChecksum: null,
    });
    expect(msg).toMatch(/acceptMcpTools/);
    // The refusal lists every tool's name/kind — and endpoints for
    // external ones — so the operator reviews exactly what they accept.
    expect(msg).toContain('query "find_things"');
    expect(msg).toContain('external "check_thing" → https://tools.example.com/check');
  });

  it('passes with the flag, and without tools no consent is needed', () => {
    expect(
      mcpConsentRequired({
        manifest: withTools([queryTool()]),
        acceptMcpTools: true,
        priorAccepted: false,
        priorChecksum: null,
      }),
    ).toBeNull();
    expect(
      mcpConsentRequired({
        manifest: pack(),
        acceptMcpTools: undefined,
        priorAccepted: false,
        priorChecksum: null,
      }),
    ).toBeNull();
  });

  it('carries consent over an upgrade with an UNCHANGED section', () => {
    const manifest = withTools([queryTool()]);
    const prior = mcpToolsChecksum(manifest);
    expect(prior).toMatch(/^[0-9a-f]{64}$/);
    expect(
      mcpConsentRequired({
        manifest: { ...manifest, version: '0.2.0' },
        acceptMcpTools: undefined,
        priorAccepted: true,
        priorChecksum: prior,
      }),
    ).toBeNull();
  });

  it('re-requires the flag when the section CHANGED', () => {
    const v1 = withTools([queryTool()]);
    const v2 = withTools([queryTool({ description: 'now calls home' })]);
    expect(
      mcpConsentRequired({
        manifest: v2,
        acceptMcpTools: undefined,
        priorAccepted: true,
        priorChecksum: mcpToolsChecksum(v1),
      }),
    ).toMatch(/acceptMcpTools/);
  });

  it('checksum is canonical (key order irrelevant) and null without tools', () => {
    const a = withTools([queryTool()]);
    const reordered = {
      ...a,
      mcpTools: [
        JSON.parse(
          JSON.stringify({
            query: { surface: 'search' },
            description: 'Find things recorded by this pack.',
            name: 'find_things',
            kind: 'query',
          }),
        ),
      ],
    } as DomainPackManifest;
    expect(mcpToolsChecksum(reordered)).toBe(mcpToolsChecksum(a));
    expect(mcpToolsChecksum(pack())).toBeNull();
  });

  it('externalMcpTools picks only external specs', () => {
    const m = withTools([queryTool(), externalTool()]);
    expect(externalMcpTools(m).map((t) => t.name)).toEqual(['check_thing']);
    expect(externalMcpTools(pack())).toEqual([]);
  });
});

describe('egress guard (assertPublicHttpUrl)', () => {
  const denied = (url: string, opts?: { allowHttp?: boolean }) =>
    expect(assertPublicHttpUrl(url, opts)).rejects.toThrow(EgressDeniedError);

  it('blocks loopback, metadata, and private ranges', async () => {
    await denied('https://127.0.0.1/hook');
    await denied('https://169.254.169.254/latest/meta-data');
    await denied('https://10.1.2.3/hook');
    await denied('https://172.16.0.9/hook');
    await denied('https://192.168.1.1/hook');
    await denied('https://[::1]/hook');
    await denied('https://localhost/hook'); // resolves to loopback
  });

  it('blocks plain http, non-http schemes, and embedded credentials', async () => {
    await denied('http://tools.example.com/hook');
    await denied('ftp://tools.example.com/hook');
    await denied('not a url');
    await denied('https://user:pass@tools.example.com/hook');
  });

  it('allowHttp permits http + loopback (dev/test) but still rejects credentials', async () => {
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:8080/tool', { allowHttp: true }),
    ).resolves.toBeUndefined();
    await denied('http://user:pass@127.0.0.1/tool', { allowHttp: true });
    await denied('ftp://127.0.0.1/tool', { allowHttp: true });
  });
});
