/**
 * Every tool brain lists carries a title and stated safety hints.
 *
 * Claude's connector directory refuses a server whose tools lack `title`
 * plus `readOnlyHint`/`destructiveHint`, and a client that auto-approves
 * reads does it off `readOnlyHint` — so a missing or wrong hint is either
 * a rejected listing or a write that ran without asking. The hints are
 * derived from the action registry (tool-annotations.ts); this pins that
 * the derivation covers the whole surface, so a new tool that is in no
 * table fails here instead of shipping with the conservative fallback.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpService } from '../src/mcp/mcp.service';
import { resolveToolProfile } from '../src/mcp/tool-profiles';
import { classifyTool } from '../src/mcp/tool-annotations';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};

const packBinding = {
  packId: 'demo',
  version: '0.1.0',
  installId: 'inst-1',
  webhookSecret: 'sec',
  tools: [
    {
      kind: 'query',
      name: 'find_things',
      description: 'Find things.',
      query: { surface: 'search' },
    },
    {
      kind: 'external',
      name: 'call_home',
      description: 'Calls the publisher.',
      endpoint: 'https://tools.example.com/hook',
    },
  ],
  namespacedPredicates: new Set(['demo__thing']),
};

function service(): McpService {
  const none = {} as never;
  return new McpService(
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    stubEmbedder as never,
    none,
    none,
    { enforceAction: () => undefined, enforceToolAction: () => undefined } as never,
    { installedPackTools: async () => [packBinding] } as never,
    {} as never, // packToolProxy — present, so external tools register
    undefined,
    undefined,
    { isNamed: async () => false, status: async () => ({}), rename: async () => '' } as never,
  );
}

interface Registered {
  title?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

function tools(server: McpServer): Record<string, Registered> {
  return (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
}

const ALL_SCOPES = ['brain:read', 'brain:write', 'brain:admin'] as never;

describe('MCP tool annotations', () => {
  beforeAll(() => {
    process.env.MCP_PACK_TOOLS_ENABLED = '1';
    process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED = '1';
  });
  afterAll(() => {
    delete process.env.MCP_PACK_TOOLS_ENABLED;
    delete process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED;
  });

  const surfaces: Array<[string, () => Promise<McpServer>]> = [
    [
      'full',
      () =>
        service().buildServer('co_test', ALL_SCOPES, { toolProfile: resolveToolProfile('full') }),
    ],
    [
      'core',
      () =>
        service().buildServer('co_test', ALL_SCOPES, { toolProfile: resolveToolProfile('core') }),
    ],
    [
      'chatgpt',
      () =>
        service().buildServer('co_test', ALL_SCOPES, {
          toolProfile: resolveToolProfile('chatgpt'),
        }),
    ],
    ['public', async () => service().buildPublicServer('https://brain.example')],
  ];

  it.each(surfaces)(
    'the %s surface: every tool is classified and annotated',
    async (_name, build) => {
      const listed = tools(await build());
      expect(Object.keys(listed).length).toBeGreaterThan(0);
      const packKinds = new Map([
        ['demo__find_things', 'read' as const],
        ['demo__call_home', 'write' as const],
      ]);
      const unclassified = Object.keys(listed).filter((n) => !classifyTool(n, { packKinds }).known);
      expect(unclassified).toEqual([]);
      for (const [name, tool] of Object.entries(listed)) {
        expect({ name, title: tool.title }).toEqual({ name, title: expect.any(String) });
        expect({ name, readOnly: typeof tool.annotations?.readOnlyHint }).toEqual({
          name,
          readOnly: 'boolean',
        });
        expect({ name, openWorld: typeof tool.annotations?.openWorldHint }).toEqual({
          name,
          openWorld: 'boolean',
        });
        if (tool.annotations?.readOnlyHint === false) {
          expect({ name, destructive: typeof tool.annotations.destructiveHint }).toEqual({
            name,
            destructive: 'boolean',
          });
        }
      }
    },
  );

  it('reads are read-only; forget and retract are destructive; record_fact is not', async () => {
    const listed = tools(await surfaces[0]![1]());
    expect(listed.search_knowledge?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(listed.synthesize?.annotations?.readOnlyHint).toBe(true);
    expect(listed.forget_entity?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(listed.retract_fact?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(listed.record_fact?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('a pack query tool reads; a pack external tool is open-world and destructive', async () => {
    const listed = tools(await surfaces[0]![1]());
    expect(listed.demo__find_things?.annotations).toMatchObject({ readOnlyHint: true });
    expect(listed.demo__call_home?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('an unknown name falls back to the conservative hints and says so', () => {
    expect(classifyTool('brand_new_tool')).toEqual({
      annotations: {
        title: 'Brand new tool',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      known: false,
    });
  });
});
