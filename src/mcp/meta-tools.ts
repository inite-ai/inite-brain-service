import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { asStructuredContent } from './structured';

/**
 * Progressive disclosure for the `core` tool profile.
 *
 * `core` lists six tools. The other twenty-six do not disappear — they
 * move behind two: `find_tool` searches the full catalogue and returns
 * real input schemas, `run_tool` executes any of them. A model that
 * needs `get_competing_facts` finds it in one call and uses it in the
 * next, and its schema was never resident in a context window that
 * never needed it.
 *
 * The security properties are unchanged, and that is the whole design
 * constraint here: the handler `run_tool` invokes is the SAME wrapped
 * closure a direct `tools/call` would reach — policy gate, RFC 9396
 * grant gate, error masking and tool observation all already applied
 * (McpService captures it at the innermost registration wrapper). A
 * tool a gate removed is not in the catalogue and `run_tool` answers
 * for it exactly as it answers for a name that never existed: existence
 * is not something a narrowed surface should leak.
 */

/** One tool as the meta pair sees it, captured at registration. */
export interface CatalogueEntry {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputShape?: ZodRawShape | undefined;
  /** The fully-wrapped handler — gates included. */
  handler: (...args: unknown[]) => unknown;
}

export interface MetaToolOptions {
  server: McpServer;
  /** Every tool registered on this server, in registration order. */
  catalogue: readonly CatalogueEntry[];
  /** Names a policy or grant gate removed — invisible and uncallable. */
  removed: ReadonlySet<string>;
  /** Names the profile already lists; excluded from search results. */
  listed: ReadonlySet<string>;
}

const MAX_RESULTS = 25;

/** JSON Schema for one tool's arguments, or undefined if it takes none. */
function schemaOf(entry: CatalogueEntry): unknown {
  if (!entry.inputShape || Object.keys(entry.inputShape).length === 0) return undefined;
  try {
    return z.toJSONSchema(z.object(entry.inputShape), { io: 'input' });
  } catch {
    // A schema the converter cannot express is still worth naming: the
    // model can call run_tool and read the validation error.
    return { type: 'object', properties: {}, note: Object.keys(entry.inputShape) };
  }
}

/**
 * Rank by where the query terms land: a name match beats a title match
 * beats a description match. Deliberately lexical — this runs inside a
 * tool call on every request, and an embedding round-trip to rank
 * twenty-six short strings would cost more than it could possibly save.
 */
function score(entry: CatalogueEntry, terms: string[]): number {
  const name = entry.name.toLowerCase();
  const title = (entry.title ?? '').toLowerCase();
  const description = (entry.description ?? '').toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (name.includes(term)) total += 10;
    if (title.includes(term)) total += 4;
    if (description.includes(term)) total += 1;
  }
  return total;
}

export function registerMetaTools({ server, catalogue, removed, listed }: MetaToolOptions): void {
  const reachable = catalogue.filter((e) => !removed.has(e.name) && !listed.has(e.name));
  const byName = new Map(reachable.map((e) => [e.name, e]));

  server.registerTool(
    'find_tool',
    {
      title: 'Find a brain tool',
      description:
        `Search the ${reachable.length} brain tools that are not listed in this connection's ` +
        'profile and get their exact input schemas. This server lists a small core surface by ' +
        'default to keep the context budget low; everything else — competing facts, provenance, ' +
        'communities, procedures, code memory, document ingest, admin — lives here. Search by ' +
        'intent ("who disagrees", "what changed", "store a document"), then call the winner with ' +
        'run_tool. Returns name, description and JSON-Schema arguments.',
      inputSchema: {
        query: z.string().max(200).describe('What you are trying to do, in your own words'),
        limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
      },
    },
    (args) => {
      const terms = args.query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 2);
      const ranked = (
        terms.length === 0
          ? reachable.map((e) => ({ e, s: 1 }))
          : reachable.map((e) => ({ e, s: score(e, terms) })).filter((r) => r.s > 0)
      )
        .sort((a, b) => b.s - a.s)
        .slice(0, args.limit ?? 8);
      const tools = ranked.map(({ e }) => ({
        name: e.name,
        description: e.title ?? e.description ?? '',
        details: e.description ?? '',
        arguments: schemaOf(e),
      }));
      const payload = {
        tools,
        // An empty result is a dead end unless the model is told what
        // else exists, so always hand back the full name list.
        allToolNames: reachable.map((e) => e.name),
        howToCall: 'run_tool({ name, args })',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: asStructuredContent(payload),
      };
    },
  );

  server.registerTool(
    'run_tool',
    {
      title: 'Run a brain tool by name',
      description:
        'Execute any brain tool that find_tool returned. `args` must match the JSON schema ' +
        'find_tool gave for that tool. Permissions are identical to calling the tool directly — ' +
        'this is a dispatch shortcut, not a way around scopes or policy.',
      inputSchema: {
        name: z.string().max(120).describe('Tool name, exactly as find_tool reported it'),
        args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool'),
      },
    },
    async (args, extra) => {
      const entry = byName.get(args.name);
      if (!entry) {
        // Same answer for "does not exist", "already listed" and
        // "removed by a gate". A narrowed surface that distinguishes
        // them is an enumeration oracle.
        return {
          content: [
            {
              type: 'text' as const,
              text: `unknown tool '${args.name}' — call find_tool to see what this connection can run`,
            },
          ],
          isError: true,
        };
      }
      // The SDK validates arguments before dispatching a direct call;
      // dispatching here has to do the same, or a malformed payload
      // reaches a handler that trusts its input.
      let parsed: unknown = args.args ?? {};
      if (entry.inputShape && Object.keys(entry.inputShape).length > 0) {
        const result = z.object(entry.inputShape).safeParse(args.args ?? {});
        if (!result.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `invalid arguments for ${entry.name}: ${result.error.issues
                  .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
                  .join('; ')}`,
              },
            ],
            isError: true,
          };
        }
        parsed = result.data;
      }
      return (await entry.handler(parsed, extra)) as never;
    },
  );
}
