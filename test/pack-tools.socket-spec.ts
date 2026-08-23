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
import { assertPublicHttpUrl, EgressDeniedError } from '../src/common/egress-guard';
import { z } from 'zod';
import {
  renderPackToolDescription,
  renderPackToolTitle,
  sanitizePackText,
} from '../src/mcp/pack-tool-render';
import { registerPackTools } from '../src/mcp/pack-tools';
import type { PackToolBinding } from '../src/mcp/pack-tools-reader.service';
import { PackToolProxyService } from '../src/mcp/pack-tool-proxy.service';
import { McpService } from '../src/mcp/mcp.service';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { PackExternalToolSpec } from '../src/ai/domain-packs';

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
  const ok = (tools: PackToolSpec[]) => expect(() => validateMcpTools(pack(), tools)).not.toThrow();
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
    expect(() => validatePack(pack({ mcpTools: [queryTool({ name: 'BAD' })] }))).toThrow(
      DomainPackError,
    );
  });

  it('rejects an empty array', () => bad([], /non-empty array/));
  it('rejects more than 8 tools', () => {
    const tools = Array.from({ length: 9 }, (_, i) => queryTool({ name: `tool_${i}` }));
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

  it('rejects an unknown kind', () => bad([{ ...queryTool(), kind: 'wasm' }], /kind/));

  it('rejects a missing / oversized description and oversized title', () => {
    bad([queryTool({ description: undefined })], /description/);
    bad([queryTool({ description: 'x'.repeat(501) })], /description/);
    bad([queryTool({ title: 'x'.repeat(81) })], /title/);
  });

  it('rejects an unknown query surface', () =>
    bad([queryTool({ query: { surface: 'raw_surql' } })], /surface/));

  it('rejects facts_by_predicate without predicates', () =>
    bad([queryTool({ query: { surface: 'facts_by_predicate' } })], /requires query.predicates/));

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
    bad([externalTool({ params: [{ name: 'p', type: 'string', maxLength: 0 }] })], /maxLength/);
    bad([externalTool({ params: [{ name: 'p', type: 'string', maxLength: 2_001 }] })], /maxLength/);
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

describe('pack tool renderer', () => {
  it('prepends the kind-specific server preamble', () => {
    expect(renderPackToolDescription({ packId: 'demo', version: '0.1.0', tool: queryTool() })).toBe(
      '[third-party tool from domain pack "demo" v0.1.0; reads this ' +
        "tenant's knowledge graph] Find things recorded by this pack.",
    );
    expect(
      renderPackToolDescription({ packId: 'demo', version: '0.1.0', tool: externalTool() }),
    ).toContain('calls an external endpoint operated by the pack publisher] ');
  });

  it('strips control/bidi/zero-width characters and collapses whitespace', () => {
    expect(sanitizePackText('a‮b​cd  e\n\tf', 100)).toBe('abcd e f');
    expect(sanitizePackText('⁦hidden⁩ ﻿text', 100)).toBe('hidden text');
  });

  it('caps to the given length and tolerates non-strings', () => {
    expect(sanitizePackText('x'.repeat(600), 500)).toHaveLength(500);
    expect(sanitizePackText(42, 10)).toBe('');
  });

  it('title: sanitized, undefined when absent or empty after strip', () => {
    expect(renderPackToolTitle(queryTool({ title: ' Nice‎ tool ' }))).toBe('Nice tool');
    expect(renderPackToolTitle(queryTool())).toBeUndefined();
    expect(renderPackToolTitle(queryTool({ title: '​​' }))).toBeUndefined();
  });
});

// ---- registration through a stub McpServer ----------------------------

interface RegisteredTool {
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function stubServer(): {
  server: never;
  tools: Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler'],
    ) => {
      tools.set(name, { config, handler });
    },
  };
  return { server: server as never, tools };
}

function binding(over: Partial<PackToolBinding> = {}): PackToolBinding {
  return {
    packId: 'demo',
    version: '0.1.0',
    installId: 'inst-1',
    webhookSecret: 'sec-1',
    tools: [
      queryTool(),
      queryTool({
        name: 'things_by_status',
        query: { surface: 'facts_by_predicate', predicates: ['status'], defaultLimit: 5 },
      }),
    ],
    namespacedPredicates: new Set(['demo__thing', 'demo__status']),
    ...over,
  };
}

function stubSearch(calls: unknown[]) {
  return {
    search: async (companyId: string, dto: unknown, scopes: unknown) => {
      calls.push({ companyId, dto, scopes });
      return { results: [] };
    },
  } as never;
}

function stubFacts(calls: unknown[]) {
  return {
    listByPredicate: async (opts: unknown) => {
      calls.push(opts);
      return { predicate: 'x', found: 0, facts: [] };
    },
  } as never;
}

describe('registerPackTools', () => {
  const FLAGS = [
    'MCP_PACK_TOOLS_ENABLED',
    'MCP_PACK_QUERY_TOOLS_ENABLED',
    'MCP_PACK_EXTERNAL_TOOLS_ENABLED',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.MCP_PACK_TOOLS_ENABLED = '1';
  });
  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  });

  function register(bindings: PackToolBinding[]) {
    const { server, tools } = stubServer();
    const searchCalls: unknown[] = [];
    const factsCalls: unknown[] = [];
    registerPackTools({
      server,
      companyId: 'co_test',
      scopes: ['brain:read'],
      bindings,
      deps: { search: stubSearch(searchCalls), facts: stubFacts(factsCalls) },
    });
    return { tools, searchCalls, factsCalls };
  }

  it('registers nothing when the master flag is off', () => {
    delete process.env.MCP_PACK_TOOLS_ENABLED;
    expect(register([binding()]).tools.size).toBe(0);
  });

  it('registers nothing when the query sub-flag is explicitly off', () => {
    process.env.MCP_PACK_QUERY_TOOLS_ENABLED = '0';
    expect(register([binding()]).tools.size).toBe(0);
  });

  it('registers namespaced names with the server preamble + fixed search schema', () => {
    const { tools } = register([binding()]);
    expect([...tools.keys()].sort()).toEqual(['demo__find_things', 'demo__things_by_status']);
    const search = tools.get('demo__find_things')!;
    expect(search.config.description).toMatch(
      /^\[third-party tool from domain pack "demo" v0\.1\.0;/,
    );
    // Fixed input surface: a pack cannot add parameters to a query tool.
    expect(Object.keys(search.config.inputSchema ?? {}).sort()).toEqual(['limit', 'query']);
    const schema = z.object(search.config.inputSchema!);
    expect(schema.safeParse({ query: 'x'.repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ query: 'ok', limit: 21 }).success).toBe(false);
  });

  it('search handler locks server-computed namespaced predicates + clamps limit', async () => {
    const { tools, searchCalls } = register([binding()]);
    await tools.get('demo__find_things')!.handler({ query: 'what things?', limit: 20 });
    const call = searchCalls[0] as { companyId: string; dto: any; scopes: unknown };
    expect(call.companyId).toBe('co_test');
    expect(call.scopes).toEqual(['brain:read']);
    // No spec predicates -> ALL pack predicates, namespaced. Never caller-supplied.
    expect([...call.dto.predicates].sort()).toEqual(['demo__status', 'demo__thing']);
    expect(call.dto.limit).toBe(20);
  });

  it('search handler applies spec defaultLimit/minConfidence and predicate subset', async () => {
    const withSpec = binding({
      tools: [
        queryTool({
          query: {
            surface: 'search',
            predicates: ['thing'],
            defaultLimit: 3,
            minConfidence: 0.7,
          },
        }),
      ],
    });
    const { tools, searchCalls } = register([withSpec]);
    await tools.get('demo__find_things')!.handler({ query: 'q' });
    const dto = (searchCalls[0] as { dto: any }).dto;
    expect(dto.predicates).toEqual(['demo__thing']);
    expect(dto.limit).toBe(3);
    expect(dto.minConfidence).toBe(0.7);
  });

  it('facts handler composes the namespaced predicate and clamps the limit', async () => {
    const { tools, factsCalls } = register([binding()]);
    await tools.get('demo__things_by_status')!.handler({ predicate: 'status', limit: 99 });
    const call = factsCalls[0] as { predicate: string; limit: number; scopes: unknown };
    expect(call.predicate).toBe('demo__status');
    expect(call.limit).toBe(50);
    expect(call.scopes).toEqual(['brain:read']);
  });

  it('facts input schema enum rejects a predicate outside the declared set', () => {
    const { tools } = register([binding()]);
    const shape = tools.get('demo__things_by_status')!.config.inputSchema!;
    expect(z.object(shape).safeParse({ predicate: 'status' }).success).toBe(true);
    expect(z.object(shape).safeParse({ predicate: 'thing' }).success).toBe(false);
    expect(z.object(shape).safeParse({ predicate: 'other__salary' }).success).toBe(false);
  });

  it('skips a duplicate full name instead of overwriting', () => {
    const dup = binding({ tools: [queryTool(), queryTool()] });
    const { tools } = register([dup]);
    expect(tools.size).toBe(1);
  });
});

describe('packIds fence (McpService.buildServer)', () => {
  const stubEmbedder = {
    cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
    getDimensions: () => 1536,
  };

  function service(bindings: PackToolBinding[]): McpService {
    const reader = { installedPackTools: async () => bindings };
    return new McpService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      stubEmbedder as never,
      {} as never,
      {} as never,
      {} as never,
      reader as never,
      {} as never, // packToolProxy
    );
  }

  function toolNames(server: unknown): string[] {
    return Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools);
  }

  it('a packIds-bound key sees only its packs declared tools', async () => {
    process.env.MCP_PACK_TOOLS_ENABLED = '1';
    try {
      const bindings = [
        binding({ packId: 'packa', namespacedPredicates: new Set(['packa__thing']) }),
        binding({ packId: 'packb', namespacedPredicates: new Set(['packb__thing']) }),
      ];
      const bound = await service(bindings).buildServer('co_test', ['brain:read'], {
        packIds: ['packa'],
      });
      const names = toolNames(bound);
      expect(names).toContain('packa__find_things');
      expect(names).not.toContain('packb__find_things');

      const unbound = await service(bindings).buildServer('co_test', ['brain:read']);
      expect(toolNames(unbound)).toEqual(
        expect.arrayContaining(['packa__find_things', 'packb__find_things']),
      );
    } finally {
      delete process.env.MCP_PACK_TOOLS_ENABLED;
    }
  });
});

// ---- external tools: registration + proxy ------------------------------

describe('registerPackTools — external tools', () => {
  const FLAGS = ['MCP_PACK_TOOLS_ENABLED', 'MCP_PACK_EXTERNAL_TOOLS_ENABLED'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const f of FLAGS) saved[f] = process.env[f];
    process.env.MCP_PACK_TOOLS_ENABLED = '1';
    process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED = '1';
  });
  afterEach(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  });

  function registerExternal(
    opts: {
      tools?: PackToolSpec[];
      proxy?: unknown;
    } = {},
  ) {
    const { server, tools } = stubServer();
    const proxyCalls: unknown[] = [];
    const proxy =
      opts.proxy === undefined
        ? {
            call: async (o: unknown) => {
              proxyCalls.push(o);
              return { content: [{ type: 'text', text: 'ok' }] };
            },
          }
        : opts.proxy;
    registerPackTools({
      server,
      companyId: 'co_test',
      scopes: ['brain:read'],
      bindings: [
        binding({
          tools: opts.tools ?? [
            externalTool({
              params: [
                { name: 'thing_id', type: 'string', required: true, maxLength: 64 },
                { name: 'mode', type: 'string', enum: ['fast', 'deep'] },
                { name: 'depth', type: 'number' },
              ],
            }),
          ],
        }),
      ],
      deps: {
        search: stubSearch([]),
        facts: stubFacts([]),
        ...(proxy ? { proxy: proxy as never } : {}),
      },
    });
    return { tools, proxyCalls };
  }

  it('registers only under the external flag AND with a proxy dep', () => {
    expect(registerExternal().tools.has('demo__check_thing')).toBe(true);
    expect(registerExternal({ proxy: null }).tools.size).toBe(0);
    process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED = '0';
    expect(registerExternal().tools.size).toBe(0);
  });

  it('declared params map to the zod input schema (required/enum/maxLength/type)', () => {
    const { tools } = registerExternal();
    const shape = tools.get('demo__check_thing')!.config.inputSchema!;
    expect(Object.keys(shape).sort()).toEqual(['depth', 'mode', 'thing_id']);
    const schema = z.object(shape);
    expect(schema.safeParse({ thing_id: 'x' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // thing_id required
    expect(schema.safeParse({ thing_id: 'x'.repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ thing_id: 'x', mode: 'slow' }).success).toBe(false);
    expect(schema.safeParse({ thing_id: 'x', depth: 'nope' }).success).toBe(false);
    expect(schema.safeParse({ thing_id: 'x', mode: 'deep', depth: 2 }).success).toBe(true);
  });

  it('handler forwards ONLY declared args to the proxy', async () => {
    const { tools, proxyCalls } = registerExternal();
    await tools.get('demo__check_thing')!.handler({
      thing_id: 'x1',
      smuggled: 'nope',
    });
    const call = proxyCalls[0] as { args: Record<string, unknown> };
    expect(call.args).toEqual({ thing_id: 'x1' });
  });

  it('external description carries the endpoint-calling preamble', () => {
    const { tools } = registerExternal();
    expect(tools.get('demo__check_thing')!.config.description).toContain(
      'calls an external endpoint operated by the pack publisher] ',
    );
  });
});

describe('PackToolProxyService — against a real local http server', () => {
  let server: http.Server;
  let port = 0;
  let behavior: (res: http.ServerResponse) => void;
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        behavior(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    process.env.MCP_PACK_TOOLS_ALLOW_HTTP = '1';
  });
  afterAll(async () => {
    delete process.env.MCP_PACK_TOOLS_ALLOW_HTTP;
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    received.length = 0;
    behavior = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: 'ok' }));
    };
  });

  const proxy = () => new PackToolProxyService();
  const extTool = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'external',
      name: 'check_thing',
      description: 'd',
      endpoint: `http://127.0.0.1:${port}/tool`,
      ...over,
    }) as PackExternalToolSpec;
  const callOnce = (
    p: PackToolProxyService,
    over: Record<string, unknown> = {},
    b: Partial<PackToolBinding> = {},
  ) => p.call({ binding: binding(b), tool: extTool(over), args: { thing_id: 'x1' } });

  it('signs the raw body with the install secret; installId (not companyId) on the wire', async () => {
    const out = await callOnce(proxy());
    expect(out.content[0]!.text).toBe('ok');
    const { headers, body } = received[0]!;
    expect(headers['x-brain-event']).toBe('mcp_tool_call');
    expect(headers['content-type']).toBe('application/json');
    const expected = 'sha256=' + createHmac('sha256', 'sec-1').update(body).digest('hex');
    expect(headers['x-brain-signature']).toBe(expected);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      event: 'mcp_tool_call',
      tool: 'check_thing',
      packId: 'demo',
      installId: 'inst-1',
      args: { thing_id: 'x1' },
    });
    expect(parsed.companyId).toBeUndefined();
    expect(typeof parsed.requestId).toBe('string');
    expect(typeof parsed.ts).toBe('string');
  });

  it('object content is relayed as text + structuredContent', async () => {
    behavior = (res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ content: { verdict: 'clean', score: 0.9 } }));
    };
    const out = await callOnce(proxy());
    expect(out.structuredContent).toEqual({ verdict: 'clean', score: 0.9 });
    expect(JSON.parse(out.content[0]!.text)).toEqual({ verdict: 'clean', score: 0.9 });
  });

  it('timeout yields a clean 424 error, never a raw stack', async () => {
    behavior = () => undefined; // never respond
    await expect(callOnce(proxy(), { timeoutMs: 150 } as never)).rejects.toThrow(
      /timed out after 150ms/,
    );
  });

  it('responses above 64 KB are rejected', async () => {
    behavior = (res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ content: 'x'.repeat(70_000) }));
    };
    await expect(callOnce(proxy())).rejects.toThrow(/exceeded 64 KB/);
  });

  it('{error} bodies surface sanitized; non-200 surfaces the status', async () => {
    behavior = (res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ error: 'boom‮ details' }));
    };
    await expect(callOnce(proxy())).rejects.toThrow(
      /external tool returned an error: boom details/,
    );
    behavior = (res) => {
      res.writeHead(503);
      res.end('oops');
    };
    await expect(callOnce(proxy())).rejects.toThrow(/answered HTTP 503/);
  });

  it('circuit breaker: 3 consecutive failures latch the endpoint for 60s', async () => {
    const p = proxy();
    behavior = (res) => {
      res.writeHead(500);
      res.end();
    };
    for (let i = 0; i < 3; i++) {
      await expect(callOnce(p)).rejects.toThrow(/answered HTTP 500/);
    }
    const hits = received.length;
    await expect(callOnce(p)).rejects.toThrow(/circuit open/);
    expect(received.length).toBe(hits); // latched call never left the process
  });

  it('egress guard applies per call: loopback blocked without ALLOW_HTTP', async () => {
    delete process.env.MCP_PACK_TOOLS_ALLOW_HTTP;
    try {
      await expect(callOnce(proxy())).rejects.toThrow(/must use https/);
      await expect(
        callOnce(proxy(), { endpoint: `https://127.0.0.1:${port}/tool` }),
      ).rejects.toThrow(/non-public address/);
    } finally {
      process.env.MCP_PACK_TOOLS_ALLOW_HTTP = '1';
    }
  });

  it('a pre-0068 install (no installId/secret) gets a clean reinstall hint', async () => {
    await expect(callOnce(proxy(), {}, { installId: null })).rejects.toThrow(/reinstall the pack/);
    await expect(callOnce(proxy(), {}, { webhookSecret: null })).rejects.toThrow(
      /reinstall the pack/,
    );
  });
});
