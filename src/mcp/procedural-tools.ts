import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ProceduralMemoryService } from '../procedural/procedural-memory.service';

export interface ProceduralReadDeps {
  procedural: ProceduralMemoryService;
}

/**
 * Registers the procedural-memory read scope (match / list) on an MCP
 * server bound to one tenant. Same `server.registerTool` pattern as
 * community-tools.ts — split out of mcp.service.ts to keep that file
 * under the max-lines gate. The community read tools register separately
 * (registerCommunityTools); buildServer wires both.
 */
export function registerProceduralReadTools(
  server: McpServer,
  companyId: string,
  deps: ProceduralReadDeps,
): void {
  // ── match_procedure ───────────────────────────────────────────────
  server.registerTool(
    'match_procedure',
    {
      title: 'Match procedural memory against a context query',
      description:
        "Cosine-matches procedural memory (curated 'how to' patterns the operator recorded) against a free-text context query. Returns top-K procedures sorted by similarity DESC then priority ASC. Use at the top of an agent loop to surface behaviour rules that should apply — e.g. \"user asks about pricing\" → \"mention they're on platinum tier; they get 20% off\". Procedural memory is the third tier alongside facts (semantic) and episodes (timeline).",
      inputSchema: {
        query: z.string().describe('Natural-language context'),
        limit: z.number().int().min(1).max(20).optional(),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Floor (default 0.4); rows below are dropped'),
      },
    },
    async (args) => {
      const out = await deps.procedural.match(companyId, {
        query: args.query,
        limit: args.limit,
        minSimilarity: args.minSimilarity,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: { matches: out } as any,
      };
    },
  );

  // ── list_procedures ───────────────────────────────────────────────
  server.registerTool(
    'list_procedures',
    {
      title: 'List recorded procedural memory entries',
      description:
        'Paginated listing of procedural memory for admin/review UIs. Sorted by priority ASC, createdAt DESC. Set includeRetired=true to see soft-deleted rows.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        includeRetired: z.boolean().optional(),
      },
    },
    async (args) => {
      const out = await deps.procedural.list(companyId, {
        limit: args.limit,
        includeRetired: args.includeRetired,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: { procedures: out } as any,
      };
    },
  );
}
