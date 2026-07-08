import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SourcesService } from '../sources/sources.service';

export interface SourceToolDeps {
  sources: SourcesService;
}

/**
 * Read surface for source reputation (source-reputation track, Phase 3).
 * Lets an agent inspect WHY brain trusts (or distrusts) a source before
 * leaning on its facts — declared identity (type/authLevel), the learned
 * per-domain agreement rates, and the reputation-over-time trail.
 */
export function registerSourceReadTools(opts: {
  server: McpServer;
  companyId: string;
  deps: SourceToolDeps;
}): void {
  const { server, companyId, deps } = opts;
  server.registerTool(
    'get_source_reputation',
    {
      title: 'Inspect the reputation of a fact source',
      description:
        'Return everything brain knows ABOUT a source (not its facts): the operator-declared identity (type, authLevel — authority in conflict resolution), the learned per-domain agreement rates (domain = predicate; null domain = the global blended rate; rates need >=8 samples before the resolver trusts them over the neutral 0.5), and the reputation-over-time history. sourceKey is `vertical:recorder` (recorder falls back to `_`) — the same key facts carry in trustSnapshot.sourceKey. Use to decide how much weight to give a fact whose trustSnapshot looks surprising.',
      inputSchema: {
        sourceKey: z
          .string()
          .max(512)
          .describe('Source key, e.g. "rent:tenant_bot" or "code:_"'),
      },
    },
    async (args) => {
      const out = await deps.sources.detail(companyId, args.sourceKey);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out as any,
      };
    },
  );
}
