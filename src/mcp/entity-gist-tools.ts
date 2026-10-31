import { z } from 'zod';
import { isoDateTime } from './iso-datetime';
import type { BrainScope } from '../auth/api-key.types';
import type { BeliefReadResult } from '../beliefs/beliefs.service';
import type { SceneReadResult } from '../scenes/scenes.service';
import { asStructuredContent } from './structured';
import { compactTimeline, renderProfile, renderTimeline } from './compact-read';
import { profileGist, timelineEpisodes, timelineGist } from './entity-views';
import type { RegisterReadToolsOptions } from './read-tools';
import { userScopeArg } from './user-scope-arg';

/**
 * get_entity_profile and get_entity_timeline — the entity reads whose
 * default text is the gist level (entity-views.ts). Registered by
 * registerEntityReadTools in read-tools.ts.
 */

export interface EntityGistDeps {
  /** Active beliefs about a subject, in one user's memory (beliefs are always personal). */
  beliefsAbout: (opts: {
    companyId: string;
    scopes: BrainScope[];
    userId: string;
    subject: string;
  }) => Promise<BeliefReadResult[]>;
  /** The visible scenes containing these turns, oldest first. */
  scenesOf: (opts: {
    companyId: string;
    scopes: BrainScope[];
    userId?: string | undefined;
    episodeIds: string[];
  }) => Promise<SceneReadResult[]>;
}

export function registerEntityProfileTool({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  // ── get_entity_profile ────────────────────────────────────────────
  server.registerTool(
    'get_entity_profile',
    {
      title: 'Get entity profile',
      description:
        'Full profile of one entity: canonical name, type, externalRefs (cross-vertical ids), and active facts. externalRefs point back to the originating vertical, where fresh state can be rehydrated via @inite/api-kit.',
      inputSchema: {
        entityId: z.string().describe('Brain entity id (knowledge_entity:...) or short id'),
        asOf: isoDateTime()
          .optional()
          .describe(
            'Valid-time as-of: facts true at this ISO 8601 moment (not a knowledge snapshot)',
          ),
        userId: userScopeArg,
        detail: z
          .enum(['text', 'compact', 'full'])
          .optional()
          .describe(
            'text (default): current state, disputes and an index of attributes. compact: every current fact, one line per attribute. full: JSON with fact ids',
          ),
      },
    },
    async (args) => {
      const out = await deps.entities.getProfile({
        companyId,
        entityIdRaw: args.entityId,
        asOfRaw: args.asOf,
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        scopes,
      });
      if (args.detail !== 'full') {
        const gist =
          args.detail === 'compact' || args.userId === undefined || !deps.gist
            ? null
            : profileGist(
                out,
                await deps.gist.beliefsAbout({
                  companyId,
                  scopes,
                  userId: args.userId,
                  subject: out.canonicalName,
                }),
              );
        return { content: [{ type: 'text', text: gist ?? renderProfile(out) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}

export function registerEntityTimelineTool({
  server,
  companyId,
  scopes,
  deps,
}: RegisterReadToolsOptions): void {
  // ── get_entity_timeline ───────────────────────────────────────────
  server.registerTool(
    'get_entity_timeline',
    {
      title: 'Get entity timeline',
      description:
        'Chronological audit of all facts brain has learned about this entity, including retracted ones. Useful for "what did we know when" investigations.',
      inputSchema: {
        entityId: z.string(),
        since: isoDateTime().optional(),
        until: isoDateTime().optional(),
        userId: userScopeArg,
        detail: z
          .enum(['text', 'compact', 'full'])
          .optional()
          .describe(
            'text (default): the scenes its facts came from, with the state changes in each, then facts from no conversation. compact: JSON with fact ids. full: adds sources and confidence',
          ),
      },
    },
    async (args) => {
      const timeline = await deps.entities.getTimeline({
        companyId,
        entityIdRaw: args.entityId,
        sinceRaw: args.since,
        untilRaw: args.until,
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        scopes,
      });
      if (args.detail === undefined || args.detail === 'text') {
        const scenes = deps.gist
          ? await deps.gist.scenesOf({
              companyId,
              scopes,
              ...(args.userId !== undefined ? { userId: args.userId } : {}),
              episodeIds: timelineEpisodes(timeline.events),
            })
          : [];
        const text = timelineGist(timeline, scenes) ?? renderTimeline(timeline);
        return { content: [{ type: 'text', text }] };
      }
      const out = args.detail === 'full' ? timeline : compactTimeline(timeline);
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}
