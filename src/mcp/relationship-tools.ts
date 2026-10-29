import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EntitiesService } from '../entities/entities.service';
import type { BrainScope } from '../auth/api-key.types';
import { asStructuredContent } from './structured';

/** The pack whose installation switches these on (packs/relationship.pack.json). */
export const RELATIONSHIP_PACK_ID = 'relationship';

/** The resource's policy action: it is the tool, read once (read-tools.ts READ_RESOURCE_ACTIONS). */
export const RELATIONSHIP_RESOURCE_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['relationship-context', 'relationship_context'],
]);

/**
 * `relationship_context` and `brain://relationship/<userId>` — what an
 * agent reads before it speaks to a person (docs/roadmap/
 * relationship-layer-2026-10.md §2.5). Registered only for a tenant with
 * the `relationship` pack active: without its vocabulary the context is
 * boundaries alone, and get_entity_profile already serves those.
 */
export function registerRelationshipTools({
  server,
  companyId,
  scopes,
  enabled,
  deps,
}: {
  server: McpServer;
  companyId: string;
  scopes: BrainScope[];
  /** Whether the tenant has the relationship pack active. */
  enabled: boolean;
  deps: { entities: EntitiesService };
}): void {
  if (!enabled) return;
  const read = (userId: string) =>
    deps.entities.getRelationshipContext({ companyId, userId, scopes });

  server.registerTool(
    'relationship_context',
    {
      title: 'Relationship context',
      description:
        "Before speaking to a person: their boundaries (how never to treat them), tone, open threads, commitments made to them (overdue first), their state as THEY last said it — `known: false` once it has run past its span, with its age — and what they said helped or did not. From the person's own memory, every item with its factId. Under a circle-bound key, only what was said in that circle plus what was shared to every circle.",
      inputSchema: {
        userId: z.string().min(1).max(200).describe('The person — their per-user memory scope'),
      },
    },
    async (args) => {
      const out = await read(args.userId);
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  server.registerResource(
    'relationship-context',
    new ResourceTemplate('brain://relationship/{userId}', { list: undefined }),
    {
      title: 'Relationship context',
      description:
        'The relationship_context of one person, as a drop-in context payload: brain://relationship/<userId>.',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const out = await read(String(params.userId));
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(out) }],
      };
    },
  );
}
