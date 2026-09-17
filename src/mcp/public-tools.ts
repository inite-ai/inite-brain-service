import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asStructuredContent } from './structured';

/**
 * The tools an agent can reach BEFORE it has a key.
 *
 * WHY THIS EXISTS. Every JSON-RPC path was behind `ApiKeyGuard`,
 * `initialize` and `tools/list` included, so a client that found this
 * server in the MCP registry could not learn what it does without first
 * completing OAuth. The 401 it got is a spec-correct auth challenge, not
 * a fault — but it means the whole distance between "found you" and
 * "asked you anything" is a wall, and the server cannot say a word to
 * help cross it.
 *
 * The onboarding wave did build onboarding tools; they are POST-auth by
 * design, and say so: "OAuth (or a pasted key) gets an agent as far as
 * 'I can call brain'". They fix the minutes AFTER a connection works.
 * These fix the minutes before.
 *
 * WHAT THEY MAY NOT DO, and the boundary is the whole design: read or
 * write a single row. They answer two questions — what is this, and how
 * do I connect — from static text. No tenant is resolved, no database is
 * touched, nothing is logged against a company. An anonymous caller
 * gains exactly the information a documentation page would give it,
 * which is why serving them costs nothing to fence.
 *
 * The full surface stays gated: calling any other tool still returns the
 * 401 challenge, so an OAuth-capable client still starts its flow at the
 * first real request. That ordering is deliberate — opening the door
 * must not stop the doorbell working.
 */

/** Names an anonymous caller may invoke. Everything else stays gated. */
export const PUBLIC_TOOL_NAMES: readonly string[] = ['about_brain', 'how_to_connect'];

export interface PublicToolOptions {
  /** Public base URL, for the links the answers hand back. */
  baseUrl: string;
}

export function registerPublicTools(opts: { server: McpServer; options: PublicToolOptions }): void {
  const { server, options } = opts;
  const base = options.baseUrl.replace(/\/+$/, '');

  server.registerTool(
    'about_brain',
    {
      title: 'About this memory server',
      description:
        'What this server is and what it can do, before you connect. Reads nothing and stores nothing.',
      inputSchema: {},
    },
    () => {
      const out = {
        what: 'A bitemporal memory layer for agents: a knowledge graph of typed facts with conflict resolution, not a document store.',
        unitOfMemory:
          'A typed fact on a graph — subject, predicate, value, valid time. Vector and BM25 search exist to find facts from free text, never to return chunks.',
        whatYouGetOnceConnected: [
          'Write a fact or a conversation turn and have entities, facts and relations extracted from it.',
          'Ask a question in natural language and get an answer that may only stand on cited facts.',
          'Contradictions are resolved rather than accumulated: a new value supersedes the old one under the predicate policy, and the old one stays queryable as history.',
        ],
        access:
          'Every tool that touches memory needs a key. Call how_to_connect for the two ways to get one.',
        docs: `${base}/en/docs`,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );

  server.registerTool(
    'how_to_connect',
    {
      title: 'How to connect to this server',
      description:
        'The two ways to authenticate, and what each is for. Reads nothing and stores nothing.',
      inputSchema: {
        client: z
          .string()
          .optional()
          .describe('Which client you are configuring, if you want the specific instructions.'),
      },
    },
    ({ client }) => {
      const out = {
        oauth: {
          how: 'Point your client at this URL and let it run the OAuth flow. The 401 you get on the first protected call carries WWW-Authenticate with the resource metadata your client needs.',
          url: `${base}/mcp`,
          bestFor:
            'Any MCP client that supports OAuth — nothing to paste, and the key never leaves the client.',
        },
        apiKey: {
          how: 'Issue a key in the dashboard and send it as `Authorization: Bearer <key>`.',
          dashboard: `${base}/en/app`,
          bestFor: 'Scripts, servers and clients without an OAuth flow.',
          scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
        },
        tenantInUrl: {
          note: 'The tenant-less URL takes the tenant from the credential, which is the form to prefer. The `/mcp/<companyId>` form exists for callers that pin it explicitly, and the path must then match the key.',
        },
        ...(client !== undefined && client.trim() !== '' ? { askedAbout: client.trim() } : {}),
        docs: `${base}/en/docs`,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: asStructuredContent(out),
      };
    },
  );
}
