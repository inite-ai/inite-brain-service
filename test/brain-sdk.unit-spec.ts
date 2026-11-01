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
import type * as Sdk from '../clients/brain-sdk/src/index';
import type { z } from 'zod';
import {
  SynthesisReasonSchema,
  SynthesizeResponseSchema,
} from '../src/contracts/synthesize/synthesize.schema';
import { SearchResponseSchema } from '../src/contracts/search/search.schema';
import {
  IngestFactResponseSchema,
  IngestMentionResponseSchema,
} from '../src/contracts/ingest/ingest.schema';
import {
  EntityProfileResponseSchema,
  EntityTimelineResponseSchema,
} from '../src/contracts/entities/entities.schema';

/**
 * The SDK cannot import the server's zod contracts (it ships with one
 * dependency, and not this repo), so its response types are copies,
 * pinned here: a field added, dropped or retyped on either side fails
 * typecheck. `Same` is mutual assignability of the exact types, so an
 * optional field that became required, or a widened enum, counts too.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractsMatch: {
  search: Same<Sdk.SearchResponse, z.infer<typeof SearchResponseSchema>>;
  synthesize: Same<Sdk.SynthesizeResponse, z.infer<typeof SynthesizeResponseSchema>>;
  reason: Same<Sdk.AnswerReason, z.infer<typeof SynthesisReasonSchema>>;
  mention: Same<Sdk.IngestMentionResponse, z.infer<typeof IngestMentionResponseSchema>>;
  fact: Same<Sdk.IngestFactResponse, z.infer<typeof IngestFactResponseSchema>>;
  entity: Same<Sdk.EntityProfile, z.infer<typeof EntityProfileResponseSchema>>;
  timeline: Same<Sdk.EntityTimeline, z.infer<typeof EntityTimelineResponseSchema>>;
} = {
  search: true,
  synthesize: true,
  reason: true,
  mention: true,
  fact: true,
  entity: true,
  timeline: true,
};

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
    const ok = (payload: unknown) => Response.json(payload);
    const missing = () => new Response('not found', { status: 404 });
    const path = String(body?.path ?? '');
    if (url.includes('/v1/memory-files/read')) {
      return store.has(path) ? ok({ path, content: store.get(path), updatedAt: 'now' }) : missing();
    }
    if (url.includes('/v1/memory-files/list')) {
      // brain's directory semantics: the path itself and what is inside it.
      const prefix = String(body?.prefix ?? '');
      return ok({
        paths: [...store.keys()].filter((p) => p === prefix || p.startsWith(`${prefix}/`)).sort(),
      });
    }
    if (url.includes('/v1/memory-files/delete')) {
      return store.delete(path) ? ok({ deleted: 1 }) : missing();
    }
    if (url.includes('/v1/memory-files')) {
      store.set(path, String(body?.content));
      return ok({ path, content: String(body?.content), updatedAt: 'now' });
    }
    for (const [route, payload] of Object.entries(routes)) {
      if (url.includes(route)) return ok(payload);
    }
    return new Response('unstubbed route', { status: 500 });
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

describe('answer', () => {
  it('passes an abstention through as null with its reason', async () => {
    expect(Object.values(contractsMatch).every(Boolean)).toBe(true);
    expect(SynthesisReasonSchema.options).toContain('harness_mode');
    const s = stub({
      '/v1/synthesize': { answer: null, reason: 'harness_mode', citations: [], results: [] },
    });
    const out = await createBrain({ apiKey: 'brain_test', fetch: s.fetchImpl }).answer(
      'who owns ledger sync?',
    );
    expect(out.answer).toBeNull();
    expect(out.reason).toBe('harness_mode');
  });
});

describe('retries, idempotency and errors', () => {
  /** A fetch that answers from a script, one response per call, recording each request. */
  function scripted(...script: Array<() => Response>) {
    const seen: Array<{ method: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), headers: init.headers as Record<string, string> });
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      return next();
    }) as unknown as typeof globalThis.fetch;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    return { seen, fetchImpl, waits, sleep };
  }
  const problem = (status: number, extra: Record<string, unknown> = {}, headers = {}) =>
    new Response(
      JSON.stringify({ type: 'about:blank', title: 'Error', status, requestId: 'req-1', ...extra }),
      { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
    );

  it('every retry of a write carries the one Idempotency-Key the call minted', async () => {
    const f = scripted(
      () => problem(503),
      () => new Response('', { status: 502 }),
      () => Response.json({ skipped: false, extractedEntityIds: [], extractedFactIds: [] }),
    );
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    await brain.remember('Maria moved to Berlin.');
    const keys = f.seen.map((r) => r.headers['Idempotency-Key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('two calls get two keys, and a caller-supplied key is used as given', async () => {
    const f = scripted(
      () => Response.json({}),
      () => Response.json({}),
      () => Response.json({}),
    );
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    await brain.request('/v1/ingest/fact', { method: 'POST', body: {} });
    await brain.request('/v1/ingest/fact', { method: 'POST', body: {} });
    await brain.request('/v1/ingest/fact', { method: 'POST', body: {}, idempotencyKey: 'mine' });
    const keys = f.seen.map((r) => r.headers['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('mine');
  });

  it('a read carries no Idempotency-Key', async () => {
    const f = scripted(() => Response.json({ entityId: 'x', events: [] }));
    await createBrain({ apiKey: 'k', fetch: f.fetchImpl }).timeline('x');
    expect(f.seen[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it("waits what Retry-After says, including the rate limiter's per-bucket header", async () => {
    const f = scripted(
      () => problem(429, {}, { 'Retry-After': '2' }),
      () => problem(429, {}, { 'Retry-After-expensive': '7' }),
      () => Response.json({ results: [] }),
    );
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    expect(await brain.recall('q')).toEqual([]);
    expect(f.waits).toEqual([2000, 7000]);
  });

  it('a Retry-After past maxDelayMs is handed to the caller instead of slept on', async () => {
    const f = scripted(() => problem(429, {}, { 'Retry-After': '600' }));
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    await expect(brain.recall('q')).rejects.toMatchObject({ status: 429, retryAfterMs: 600_000 });
    expect(f.waits).toEqual([]);
  });

  it('backs off exponentially with full jitter, inside the cap, and gives up after the budget', async () => {
    const f = scripted(...Array.from({ length: 4 }, () => () => problem(503)));
    const brain = createBrain({
      apiKey: 'k',
      fetch: f.fetchImpl,
      sleep: f.sleep,
      retry: { retries: 3, baseDelayMs: 100, maxDelayMs: 250 },
    });
    await expect(brain.recall('q')).rejects.toMatchObject({ status: 503 });
    expect(f.seen).toHaveLength(4);
    const ceilings = [100, 200, 250];
    f.waits.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(ceilings[i]!);
    });
  });

  it('a network failure is retried; status 0 when it never recovers', async () => {
    const fail = () => {
      throw new TypeError('fetch failed');
    };
    const f = scripted(fail, () => Response.json({ results: [] }));
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    expect(await brain.recall('q')).toEqual([]);

    const g = scripted(fail, fail);
    const once = createBrain({
      apiKey: 'k',
      fetch: g.fetchImpl,
      sleep: g.sleep,
      retry: { retries: 1 },
    });
    await expect(once.recall('q')).rejects.toMatchObject({ status: 0, message: /fetch failed/ });
  });

  it('a 500 is retried for a read and not for a write', async () => {
    const r = scripted(
      () => problem(500),
      () => Response.json({ entityId: 'x', events: [] }),
    );
    await createBrain({ apiKey: 'k', fetch: r.fetchImpl, sleep: r.sleep }).timeline('x');
    expect(r.seen).toHaveLength(2);

    const w = scripted(() => problem(500));
    const writer = createBrain({ apiKey: 'k', fetch: w.fetchImpl, sleep: w.sleep });
    await expect(writer.remember('x')).rejects.toMatchObject({ status: 500 });
    expect(w.seen).toHaveLength(1);
  });

  it('a 409 is retried only when brain says when to come back', async () => {
    // "The first request under this key is still running" carries a
    // Retry-After; a conflict that will be the same answer next time does not.
    const inFlight = scripted(
      () => problem(409, {}, { 'Retry-After': '1' }),
      () => Response.json({ factId: 'f1', outcome: 'INSERTED' }),
    );
    const b1 = createBrain({ apiKey: 'k', fetch: inFlight.fetchImpl, sleep: inFlight.sleep });
    await b1.request('/v1/ingest/fact', { method: 'POST', body: {} });
    expect(inFlight.seen).toHaveLength(2);

    const real = scripted(() => problem(409));
    const b2 = createBrain({ apiKey: 'k', fetch: real.fetchImpl, sleep: real.sleep });
    await expect(b2.request('/x', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
    });
    expect(real.seen).toHaveLength(1);
  });

  it('a 4xx is the answer: thrown at once, with the problem details read', async () => {
    const f = scripted(() =>
      problem(400, {
        title: 'Bad Request',
        detail: 'predicate: required',
        errors: ['predicate: required'],
      }),
    );
    const brain = createBrain({ apiKey: 'k', fetch: f.fetchImpl, sleep: f.sleep });
    const error = (await brain
      .request('/v1/ingest/fact', { method: 'POST', body: {} })
      .catch((e: unknown) => e)) as BrainError;
    expect(error).toBeInstanceOf(BrainError);
    expect(error.status).toBe(400);
    expect(error.detail).toBe('predicate: required');
    expect(error.type).toBe('about:blank');
    expect(error.problem?.errors).toEqual(['predicate: required']);
    expect(error.requestId).toBe('req-1');
    expect(error.message).toContain('predicate: required');
    expect(f.seen).toHaveLength(1);
  });

  it('a non-JSON error body still lands in the message, with the request id header', async () => {
    const f = scripted(
      () =>
        new Response('<html>bad gateway</html>', {
          status: 400,
          headers: { 'x-request-id': 'r9' },
        }),
    );
    const error = (await createBrain({ apiKey: 'k', fetch: f.fetchImpl })
      .recall('q')
      .catch((e: unknown) => e)) as BrainError;
    expect(error.problem).toBeUndefined();
    expect(error.requestId).toBe('r9');
    expect(error.message).toContain('bad gateway');
  });

  it("the caller's abort ends the call, also during a backoff wait", async () => {
    const controller = new AbortController();
    const f = scripted(() => problem(503));
    const brain = createBrain({
      apiKey: 'k',
      fetch: f.fetchImpl,
      sleep: () => new Promise(() => controller.abort(new Error('caller gave up'))),
    });
    await expect(
      brain.request('/v1/search', { method: 'POST', body: {}, signal: controller.signal }),
    ).rejects.toThrow('caller gave up');
    expect(f.seen).toHaveLength(1);
  });

  it('a 204 resolves without a body', async () => {
    const f = scripted(() => new Response(null, { status: 204 }));
    await expect(
      createBrain({ apiKey: 'k', fetch: f.fetchImpl }).request('/v1/x', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });
});
