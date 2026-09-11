/**
 * The ChatGPT connector facade.
 *
 * ChatGPT's deep-research and company-knowledge connectors accept
 * exactly two read-only tools, named `search` and `fetch`, with
 * prescribed result shapes — a connector exposing anything else is
 * rejected. This spec holds that contract, because nothing in the build
 * would otherwise notice it breaking: the failure happens inside
 * someone else's product, weeks later, as "the connector was refused".
 */
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveToolProfile } from '../src/mcp/tool-profiles';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};
const stubPackToolsReader = { installedPackTools: async () => [] };

const HIT = {
  entityId: 'cuid_maria',
  entityType: 'customer',
  canonicalName: 'Maria Alvarez',
  externalRefs: { 'rent:cust_42': 'cust_42' },
  score: 0.9,
  facts: [
    {
      factId: 'f1',
      predicate: 'lives_in',
      object: 'Berlin',
      confidence: 1,
      validFrom: 'x',
      status: 'active',
      score: 1,
    },
    {
      factId: 'f2',
      predicate: 'prefers',
      object: 'morning appointments',
      confidence: 1,
      validFrom: 'x',
      status: 'active',
      score: 1,
    },
  ],
};

const PROFILE = {
  entityId: 'cuid_maria',
  type: 'customer',
  canonicalName: 'Maria Alvarez',
  externalRefs: { rent: 'cust_42' },
  facts: [
    {
      factId: 'f1',
      predicate: 'lives_in',
      object: 'Berlin',
      confidence: 1,
      validFrom: '2026-06-01T00:00:00Z',
      status: 'active',
    },
    {
      factId: 'f2',
      predicate: 'lives_in',
      object: 'Madrid',
      confidence: 1,
      validFrom: '2020-01-01T00:00:00Z',
      validUntil: '2026-06-01T00:00:00Z',
      status: 'superseded',
    },
  ],
};

function service(): McpService {
  const search = { search: async () => ({ results: [HIT] }) };
  const entities = { getProfile: async () => PROFILE };
  return new McpService(
    search as never,
    entities as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    stubEmbedder as never,
    {} as never,
    {} as never,
    { enforceAction: () => undefined, enforceToolAction: () => undefined } as never,
    stubPackToolsReader as never,
    {} as never,
  );
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}
const internals = (server: McpServer) =>
  (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

const call = (server: McpServer, name: string, args: unknown) =>
  internals(server)[name]!.handler(args, {} as never);

const build = (profile = 'chatgpt') =>
  service().buildServer('co_test', ['brain:read'], {
    actorKeyHash: 'sha256:test',
    toolProfile: resolveToolProfile(profile),
  });

describe('the chatgpt profile', () => {
  const savedUrl = process.env.BRAIN_PUBLIC_URL;
  beforeEach(() => {
    process.env.BRAIN_PUBLIC_URL = 'https://brain.inite.ai';
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.BRAIN_PUBLIC_URL;
    else process.env.BRAIN_PUBLIC_URL = savedUrl;
  });

  it('exposes exactly search and fetch', async () => {
    // Not "at least" — exactly. The connector is rejected otherwise.
    expect(Object.keys(internals(await build())).sort()).toEqual(['fetch', 'search']);
  });

  it('leaves the normal surface alone on every other profile', async () => {
    const names = Object.keys(internals(await build('full')));
    expect(names).toContain('search_knowledge');
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch');
  });

  describe('search', () => {
    it('answers in both encodings the spec asks for', async () => {
      const out = (await call(await build(), 'search', { query: 'Maria' })) as {
        content: { type: string; text: string }[];
        structuredContent: { results: unknown[] };
      };
      // structuredContent AND the same object JSON-encoded into text.
      expect(JSON.parse(out.content[0]!.text)).toEqual(out.structuredContent);
      expect(out.structuredContent.results).toHaveLength(1);
    });

    it('returns id, title, text and url on every result', async () => {
      const out = (await call(await build(), 'search', { query: 'Maria' })) as {
        structuredContent: { results: Record<string, string>[] };
      };
      const [first] = out.structuredContent.results;
      expect(Object.keys(first!).sort()).toEqual(['id', 'text', 'title', 'url']);
      expect(first!.id).toBe('cuid_maria');
      expect(first!.title).toBe('Maria Alvarez');
      expect(first!.text).toContain('lives_in: Berlin');
    });

    it('links each result at the entity screen, which is what makes it a citation', async () => {
      // ChatGPT builds citation metadata only when url is a non-empty
      // string, and the link has to land somewhere real — the app reads
      // ?entity= and opens that profile.
      const out = (await call(await build(), 'search', { query: 'Maria' })) as {
        structuredContent: { results: { url: string }[] };
      };
      expect(out.structuredContent.results[0]!.url).toBe(
        'https://brain.inite.ai/en/app/entities?entity=cuid_maria',
      );
    });

    it('emits an empty url rather than a broken one when no public URL is configured', async () => {
      delete process.env.BRAIN_PUBLIC_URL;
      const out = (await call(await build(), 'search', { query: 'Maria' })) as {
        structuredContent: { results: { url: string }[] };
      };
      // Results then stay ordinary tool output — the correct degradation
      // for a self-hosted deployment with no public address.
      expect(out.structuredContent.results[0]!.url).toBe('');
    });
  });

  describe('fetch', () => {
    it('returns the full record in the shape the spec names', async () => {
      const out = (await call(await build(), 'fetch', { id: 'cuid_maria' })) as {
        content: { text: string }[];
        structuredContent: Record<string, unknown>;
      };
      expect(JSON.parse(out.content[0]!.text)).toEqual(out.structuredContent);
      expect(Object.keys(out.structuredContent).sort()).toEqual([
        'id',
        'metadata',
        'text',
        'title',
        'url',
      ]);
      expect(out.structuredContent.id).toBe('cuid_maria');
      expect(out.structuredContent.title).toBe('Maria Alvarez');
    });

    it('renders the validity window, which is the thing brain knows that a document store does not', async () => {
      const out = (await call(await build(), 'fetch', { id: 'cuid_maria' })) as {
        structuredContent: { text: string; metadata: Record<string, string> };
      };
      expect(out.structuredContent.text).toContain('lives_in: Berlin (from 2026-06-01T00:00:00Z)');
      expect(out.structuredContent.text).toContain('until 2026-06-01T00:00:00Z');
      expect(out.structuredContent.text).toContain('Known as: rent=cust_42');
      expect(out.structuredContent.metadata.entityType).toBe('customer');
      expect(out.structuredContent.metadata.factCount).toBe('2');
    });
  });
});
