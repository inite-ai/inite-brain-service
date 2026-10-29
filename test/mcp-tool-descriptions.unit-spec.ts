/**
 * Tool descriptions say what a tool does — never what the model should do.
 *
 * Claude's connector directory asks the publisher to attest that tool
 * descriptions "contain no instructions about model behavior, other tools,
 * or external instruction sources", and reviewers reject descriptions that
 * read like prompt injection. "Use BEFORE search_knowledge…", "Call it
 * right after connecting" and "Prefer this over record_fact" were all of
 * that kind. This pins the whole listed surface: no description names
 * another tool, and none addresses the model in the imperative.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpService } from '../src/mcp/mcp.service';
import { resolveToolProfile } from '../src/mcp/tool-profiles';

const none = {} as never;
function service(): McpService {
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
    { cacheStats: () => ({ provider: 'test' }), getDimensions: () => 1024 } as never,
    none,
    none,
    { enforceAction: () => undefined, enforceToolAction: () => undefined } as never,
    { isActive: async () => false, installedPackTools: async () => [] } as never,
    none,
    undefined,
    undefined,
    { isNamed: async () => false, status: async () => ({}), rename: async () => '' } as never,
  );
}

function described(server: McpServer): Array<[string, string]> {
  const tools = (
    server as unknown as { _registeredTools: Record<string, { description?: string }> }
  )._registeredTools;
  return Object.entries(tools).map(([name, t]) => [name, t.description ?? '']);
}

const IMPERATIVE =
  /\b(use (this|it|when|before|after|instead)|use [A-Z]+ |call (it|this)|prefer (this|it)|you (must|should))\b/i;

const ALL = ['brain:read', 'brain:write', 'brain:admin'] as never;

/** Build with EXTRACTION_SOURCE=harness, so the harness extraction tools are listed too. */
async function inHarness(build: () => Promise<McpServer>): Promise<McpServer> {
  const before = process.env.EXTRACTION_SOURCE;
  process.env.EXTRACTION_SOURCE = 'harness';
  try {
    return await build();
  } finally {
    if (before === undefined) delete process.env.EXTRACTION_SOURCE;
    else process.env.EXTRACTION_SOURCE = before;
  }
}

describe('MCP tool descriptions', () => {
  const surfaces: Array<[string, () => Promise<McpServer>]> = [
    ['full', () => service().buildServer('co_t', ALL, { toolProfile: resolveToolProfile('full') })],
    ['core', () => service().buildServer('co_t', ALL, { toolProfile: resolveToolProfile('core') })],
    [
      'full (harness extraction)',
      () =>
        inHarness(() =>
          service().buildServer('co_t', ALL, { toolProfile: resolveToolProfile('full') }),
        ),
    ],
    ['public', async () => service().buildPublicServer('https://brain.example')],
  ];

  it.each(surfaces)(
    'the %s surface names no other tool and gives the model no orders',
    async (_n, build) => {
      const tools = described(await build());
      // Only snake_case names: `search`, `fetch` and `why` are also words.
      const names = tools.map(([n]) => n).filter((n) => n.includes('_'));
      const offences: string[] = [];
      for (const [name, text] of tools) {
        for (const other of names) {
          if (other !== name && new RegExp(`\\b${other}\\b`).test(text))
            offences.push(`${name} names ${other}`);
        }
        const order = IMPERATIVE.exec(text);
        if (order) offences.push(`${name}: "${order[0]}"`);
      }
      expect(offences).toEqual([]);
    },
  );
});
