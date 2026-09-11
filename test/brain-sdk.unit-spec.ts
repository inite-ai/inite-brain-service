/**
 * The TypeScript SDK.
 *
 * Two things here are worth more than the rest of the surface combined:
 * that the per-user scope is threaded onto EVERY call (forgetting it on
 * one side of a read/write pair is the commonest way a memory
 * integration silently returns nothing), and that the LangGraph-shaped
 * store answers a miss with null rather than an exception, because a
 * graph node written against any other store will not be wrapping it in
 * a try/catch.
 */
import {
  createBrain,
  createBrainStore,
  brainTools,
  BrainError,
} from '../clients/brain-sdk/src/index';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function stub(routes: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const calls: Call[] = [];
  const store = new Map(Object.entries(files));
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: String(init.method), body });
    const ok = (payload: unknown) => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    const path = String(body?.path ?? '');
    if (url.includes('/v1/memory-files/read')) {
      return store.has(path)
        ? ok({ path, content: store.get(path), updatedAt: 'now' })
        : { ok: false, status: 404, text: async () => 'not found' };
    }
    if (url.includes('/v1/memory-files/list')) {
      const prefix = String(body?.prefix ?? '');
      return ok({ paths: [...store.keys()].filter((p) => p.startsWith(prefix)).sort() });
    }
    if (url.includes('/v1/memory-files/delete')) {
      return store.delete(path)
        ? ok({ deleted: 1 })
        : { ok: false, status: 404, text: async () => 'not found' };
    }
    if (url.includes('/v1/memory-files')) {
      store.set(path, String(body?.content));
      return ok({ path, content: String(body?.content), updatedAt: 'now' });
    }
    for (const [route, payload] of Object.entries(routes)) {
      if (url.includes(route)) return ok(payload);
    }
    return { ok: false, status: 500, text: async () => 'unstubbed route' };
  }) as unknown as typeof globalThis.fetch;
  return { calls, store, fetchImpl };
}

const HITS = {
  results: [
    {
      entityId: 'cuid_maria',
      entityType: 'customer',
      canonicalName: 'Maria',
      score: 1,
      facts: [
        {
          factId: 'f1',
          predicate: 'lives_in',
          object: 'Berlin',
          confidence: 1,
          validFrom: '2026-06-01T00:00:00Z',
          status: 'active',
        },
      ],
    },
  ],
};

describe('the client', () => {
  it('refuses to construct without a key', () => {
    expect(() => createBrain({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('carries the bearer key and talks to the documented routes', async () => {
    const s = stub({ '/v1/search': HITS });
    const brain = createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl });
    const hits = await brain.recall('where does Maria live');
    expect(hits[0]!.canonicalName).toBe('Maria');
    expect(s.calls[0]!.url).toContain('/v1/search');
    expect(s.calls[0]!.method).toBe('POST');
  });

  it('threads the user scope onto every body', async () => {
    // Writing with a userId and reading without one returns nothing, and
    // nothing about that failure looks like a bug — so the scope is not
    // something a caller gets to forget per call.
    const s = stub({ '/v1/search': HITS, '/v1/ingest/mention': { skipped: false } });
    const brain = createBrain({ apiKey: 'brain_test', userId: 'user_42', fetch: s.fetchImpl });
    await brain.remember('Maria moved to Berlin in June.');
    await brain.recall('Maria');
    expect(s.calls.map((c) => c.body?.userId)).toEqual(['user_42', 'user_42']);
  });

  it('threads it onto a GET as a query parameter, where there is no body', async () => {
    const s = stub({ '/timeline': { entityId: 'cuid_maria', events: [] } });
    const brain = createBrain({ apiKey: 'brain_test', userId: 'user_42', fetch: s.fetchImpl });
    await brain.timeline('cuid_maria', { since: '2026-01-01T00:00:00Z' });
    expect(s.calls[0]!.url).toContain('userId=user_42');
    expect(s.calls[0]!.url).toContain('since=2026-01-01');
  });

  it('lets an explicit userId win over the configured one', async () => {
    const s = stub({ '/v1/ingest/fact': { factId: 'f1', outcome: 'INSERTED' } });
    const brain = createBrain({ apiKey: 'brain_test', userId: 'user_42', fetch: s.fetchImpl });
    await brain.request('/v1/ingest/fact', { method: 'POST', body: { userId: 'user_7' } });
    expect(s.calls[0]!.body?.userId).toBe('user_7');
  });

  it('raises a typed error carrying the status', async () => {
    const s = stub();
    const brain = createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl });
    await expect(brain.recall('anything')).rejects.toBeInstanceOf(BrainError);
    await expect(brain.recall('anything')).rejects.toMatchObject({ status: 500 });
  });

  it('escapes an entity id into the path', async () => {
    const s = stub({
      '/v1/entities/': { entityId: 'x', type: 't', canonicalName: 'n', facts: [] },
    });
    const brain = createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl });
    await brain.entity('knowledge_entity:cuid_x');
    expect(s.calls[0]!.url).toContain('knowledge_entity%3Acuid_x');
  });
});

describe('brainTools', () => {
  it('exposes four tools in the shape a framework takes', () => {
    const s = stub();
    const tools = brainTools(createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl }));
    expect(Object.keys(tools).sort()).toEqual([
      'answer_from_memory',
      'memory_history',
      'recall_memory',
      'remember',
    ]);
    for (const tool of Object.values(tools)) {
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.execute).toBe('function');
      // A zod schema, which is what the AI SDK and the OpenAI Agents SDK
      // both accept — the reason this package has exactly one dependency.
      expect(typeof (tool.inputSchema as { safeParse?: unknown }).safeParse).toBe('function');
    }
  });

  it('flattens a hit into something a model can read', async () => {
    const s = stub({ '/v1/search': HITS });
    const tools = brainTools(createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl }));
    const out = (await tools.recall_memory!.execute({ query: 'Maria' } as never)) as {
      name: string;
      facts: { statement: string; from: string }[];
    }[];
    expect(out[0]!.name).toBe('Maria');
    expect(out[0]!.facts[0]!.statement).toBe('lives_in Berlin');
  });

  it('reports a skipped write as stored:false instead of pretending', async () => {
    const s = stub({ '/v1/ingest/mention': { skipped: true, reason: 'no_extraction' } });
    const tools = brainTools(createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl }));
    expect(await tools.remember!.execute({ text: 'hello' } as never)).toEqual({
      stored: false,
      reason: 'no_extraction',
    });
  });
});

describe('the LangGraph-shaped store', () => {
  const brainFor = (s: ReturnType<typeof stub>) =>
    createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl });

  it('round-trips a value through a namespaced key', async () => {
    const s = stub();
    const store = createBrainStore(brainFor(s));
    await store.put(['users', 'u1', 'prefs'], 'editor', { tabs: true });
    expect(s.store.get('/memories/users/u1/prefs/editor.json')).toBe('{"tabs":true}');
    const item = await store.get<{ tabs: boolean }>(['users', 'u1', 'prefs'], 'editor');
    expect(item?.value.tabs).toBe(true);
    expect(item?.namespace).toEqual(['users', 'u1', 'prefs']);
    expect(item?.key).toBe('editor');
  });

  it('answers a miss with null, not an exception', async () => {
    // Every other store behaves this way; a graph node written against
    // one of them will not be wrapping this in a try/catch.
    const store = createBrainStore(brainFor(stub()));
    expect(await store.get(['users', 'u1'], 'nope')).toBeNull();
  });

  it('treats deleting what is not there as a no-op', async () => {
    const store = createBrainStore(brainFor(stub()));
    await expect(store.delete(['users', 'u1'], 'nope')).resolves.toBeUndefined();
  });

  it('searches a namespace prefix and filters on stored fields', async () => {
    const s = stub();
    const store = createBrainStore(brainFor(s));
    await store.put(['users', 'u1'], 'a', { kind: 'note' });
    await store.put(['users', 'u1'], 'b', { kind: 'task' });
    expect((await store.search(['users', 'u1'])).map((i) => i.key).sort()).toEqual(['a', 'b']);
    const tasks = await store.search(['users', 'u1'], { filter: { kind: 'task' } });
    expect(tasks.map((i) => i.key)).toEqual(['b']);
  });

  it('lists distinct namespaces', async () => {
    const s = stub();
    const store = createBrainStore(brainFor(s));
    await store.put(['users', 'u1'], 'a', {});
    await store.put(['users', 'u2'], 'b', {});
    expect(await store.listNamespaces({ prefix: ['users'] })).toEqual([
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
  });

  it('rejects a namespace that would change the path shape', async () => {
    // Silently escaping it would put the data somewhere the caller
    // cannot find again, which is worse than a loud failure.
    const store = createBrainStore(brainFor(stub()));
    await expect(store.put(['users', '../etc'], 'a', {})).rejects.toThrow(/invalid namespace/);
    await expect(store.put(['users', 'a/b'], 'a', {})).rejects.toThrow(/invalid namespace/);
    await expect(store.put(['users'], '', {})).rejects.toThrow(/invalid key/);
  });
});
