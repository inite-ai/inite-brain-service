import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SearchService } from '../search/search.service';
import type { EntitiesService } from '../entities/entities.service';
import type { BrainScope } from '../auth/api-key.types';

/**
 * The ChatGPT connector facade — `search` and `fetch`, and nothing else.
 *
 * ChatGPT's deep-research and company-knowledge connectors do not browse
 * an arbitrary tool surface. They require exactly two read-only tools
 * with prescribed names and result shapes, and a connector that exposes
 * anything else is rejected. That is not a limitation to work around:
 * it is a different product's contract, and the honest way to satisfy it
 * is a thin facade over the memory we already have, not a redesign of
 * brain's own tools.
 *
 * Shape, from the OpenAI connector spec:
 *   search(query)  → { results: [{ id, title, text, url }] }
 *   fetch(id)      → { id, title, text, url, metadata }
 * Both answer with `structuredContent` AND the same object JSON-encoded
 * into a text content block — the compatibility form the spec asks for.
 *
 * `url` is what turns a result into a citation: ChatGPT builds citation
 * metadata only when it is a non-empty string. It points at the entity
 * screen in the web app, which reads `?entity=` and opens that entity's
 * profile. A deployment with no BRAIN_PUBLIC_URL emits an empty string
 * rather than a link that goes nowhere — results are then ordinary tool
 * output, which is the correct degradation.
 */

export interface ChatGptToolDeps {
  search: SearchService;
  entities: EntitiesService;
}

export interface RegisterChatGptToolsOptions {
  server: McpServer;
  companyId: string;
  scopes: BrainScope[];
  deps: ChatGptToolDeps;
}

const SEARCH_LIMIT = 10;
/** Enough for the model to choose what to fetch, short enough to scan. */
const SNIPPET_FACTS = 4;

/** Deep link into the web app's entity screen, or '' when we have no base. */
function entityUrl(entityId: string): string {
  const base = (process.env.BRAIN_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/en/app/entities?entity=${encodeURIComponent(entityId)}`;
}

/** The dual-encoding every result uses: structured plus JSON-in-text. */
function dual(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const factLine = (f: { predicate: string; object: string }): string =>
  `${f.predicate}: ${f.object}`;

export function registerChatGptTools({
  server,
  companyId,
  scopes,
  deps,
}: RegisterChatGptToolsOptions): void {
  server.registerTool(
    'search',
    {
      title: 'Search memory',
      description:
        'Search this workspace’s memory — people, places, projects, topics and the facts recorded ' +
        'about them — and return matching records. Each result carries an id for fetch, a title, a ' +
        'short summary of what is known, and a link to the record.',
      inputSchema: {
        query: z.string().max(2_000).describe('Search query'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            text: z.string(),
            url: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      const out = await deps.search.search(
        companyId,
        { query: args.query, limit: SEARCH_LIMIT },
        scopes,
      );
      const results = out.results.map((hit) => ({
        id: hit.entityId,
        title: hit.canonicalName,
        text: hit.facts.slice(0, SNIPPET_FACTS).map(factLine).join('; '),
        url: entityUrl(hit.entityId),
      }));
      return dual({ results });
    },
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch a memory record',
      description:
        'Retrieve the full record for an id returned by search: every fact currently held about ' +
        'that entity, with the validity window each one is true for, plus its external references.',
      inputSchema: {
        id: z.string().max(256).describe('Record id, exactly as search returned it'),
      },
      outputSchema: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()),
      },
    },
    async (args) => {
      const profile = await deps.entities.getProfile({
        companyId,
        entityIdRaw: args.id,
        asOfRaw: undefined,
        recordedAtRaw: undefined,
        scopes,
      });
      const lines = profile.facts.map((f) => {
        const until = f.validUntil ? ` until ${f.validUntil}` : '';
        return `- ${factLine(f)} (from ${f.validFrom}${until})`;
      });
      const refs = Object.entries(profile.externalRefs).map(([k, v]) => `${k}=${v}`);
      const text = [
        `${profile.canonicalName} (${profile.type})`,
        '',
        lines.length > 0 ? lines.join('\n') : 'No facts recorded yet.',
        refs.length > 0 ? `\nKnown as: ${refs.join(', ')}` : '',
      ]
        .join('\n')
        .trim();
      return dual({
        id: profile.entityId,
        title: profile.canonicalName,
        text,
        url: entityUrl(profile.entityId),
        metadata: {
          entityType: profile.type,
          factCount: String(profile.facts.length),
          // A merged entity is a redirect; saying so beats returning a
          // stub the model reads as "nothing known".
          ...(profile.mergedInto ? { mergedInto: profile.mergedInto } : {}),
        },
      });
    },
  );
}
