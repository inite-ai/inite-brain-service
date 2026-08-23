import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CommunityService } from '../communities/community.service';
import { asStructuredContent } from './structured';

/**
 * Registers the topic-community read scope (graphiti-style communities)
 * on an MCP server bound to one tenant. Split out of mcp.service.ts purely
 * to keep that file under the max-lines gate — same `server.registerTool`
 * pattern as the read tools there.
 */
export function registerCommunityTools(
  server: McpServer,
  companyId: string,
  deps: {
    communities: CommunityService;
    /**
     * Caller scopes — threads the DB-level PII fence through the
     * scoped pool (community summaries are fact-derived).
     */
    scopes?: readonly string[];
  },
): void {
  const { communities, scopes = [] } = deps;
  // ── search_communities ──────────────────────────────────────────────
  server.registerTool(
    'search_communities',
    {
      title: 'Search topic communities (coarse retrieval scope)',
      description:
        'Cosine-matches the query against topic-community summaries — the coarse retrieval scope. A community is a cluster of related entities (label propagation over the entity graph) with one rolled-up summary. Use BEFORE search_knowledge when the question is broad ("what do we know about X domain") to get an overview instead of a fact firehose, then drill into specific entities. Communities are (re)built off-hours by the dreams loop; an empty result means clustering has not run or the graph is too sparse.',
      inputSchema: {
        query: z.string().describe('Natural-language topic / domain'),
        limit: z.number().int().min(1).max(20).optional(),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Floor (default 0.3); rows below are dropped'),
      },
    },
    async (args) => {
      const out = await communities.search(companyId, {
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        minSimilarity: args.minSimilarity,
        callerScopes: scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent({ communities: out }),
      };
    },
  );

  // ── list_communities ────────────────────────────────────────────────
  server.registerTool(
    'list_communities',
    {
      title: 'List topic communities',
      description:
        'Paginated listing of topic communities, largest first. Each row carries a label, a rolled-up summary, and the member count. Use to enumerate the knowledge map at a glance.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const out = await communities.list(companyId, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        callerScopes: scopes,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent({ communities: out }),
      };
    },
  );

  // ── find_entity_communities ─────────────────────────────────────────
  server.registerTool(
    'find_entity_communities',
    {
      title: 'Find the communities an entity belongs to',
      description:
        'Returns the topic communities a given entity is a member of. Use to place an entity in its broader context — which clusters / themes it participates in — or to pivot from one entity to the wider neighbourhood the cluster summarises.',
      inputSchema: {
        entityId: z.string().describe('knowledge_entity id'),
      },
    },
    async (args) => {
      const out = await communities.forEntity(companyId, args.entityId, scopes);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent({ communities: out }),
      };
    },
  );
}
