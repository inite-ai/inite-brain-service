/**
 * G4 strategy-memory lane e2e (docs/roadmap/sota-gap-build-2026-08.md):
 *
 *   1. Flags off → the admin surface 404s (indistinguishable from
 *      "not deployed").
 *   2. Master on, retrieval off → distill / list / status-flip work,
 *      but synthesize serves NO advisory section even with an active
 *      item and the lane in the profile.
 *   3. Both on → the generator prompt carries the fenced ADVISORY
 *      note; the VERIFIER prompt does not (the documented parity
 *      exception).
 *   4. LEAKAGE (the structural guarantee): a strategy item whose text
 *      matches the query appears in NO fact-lane search result and in
 *      NO synthesize citation — the separate table makes this
 *      structural; this spec pins it stays that way.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { StrategyMemoryService } from '../src/strategy/strategy-memory.service';
import { StrategyDistillService } from '../src/strategy/strategy-distill.service';

const STRATEGY_ENV_KEYS = [
  'STRATEGY_MEMORY_ENABLED',
  'STRATEGY_RETRIEVAL_ENABLED',
  'STRATEGY_SIMILARITY_FLOOR',
  'STRATEGY_DISTILL_CRON_ENABLED',
  'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
];

function clearStrategyEnv(): void {
  for (const k of STRATEGY_ENV_KEYS) delete process.env[k];
}

/** Scripted OpenAI stub for the distiller (the mockSynthesizeOpenAi idiom). */
function mockDistillOpenAi(
  svc: StrategyDistillService,
  responses: string[],
): { calls: number } {
  const state = { calls: 0 };
  const stub = {
    chat: {
      completions: {
        create: async () => {
          const content =
            responses[state.calls] ?? responses[responses.length - 1] ?? '{}';
          state.calls++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  (svc as unknown as { openai: typeof stub }).openai = stub;
  return state;
}

const POST_MORTEM = {
  question: 'How many weeks ago did I attend the sale?',
  goldAnswer: '3 weeks ago',
  ourAnswer: '5 weeks ago',
  diagnosis: 'freehand date arithmetic instead of the computed table',
};

const DISTILLED = JSON.stringify({
  items: [
    {
      title: 'trust the computed date table',
      situation: 'temporal-distance questions with dated evidence',
      strategy:
        'Derive elapsed intervals from the computed date table rather than freehand arithmetic, because manual calendar math is the dominant temporal failure mode.',
      polarity: 'do',
    },
  ],
});

describe('strategy lane — flags off (default)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    clearStrategyEnv();
    f = await createApp();
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('admin endpoints 404 — indistinguishable from not deployed', async () => {
    const distill = await f.http
      .post('/v1/admin/strategy/distill')
      .set(auth())
      .send({ postMortems: [POST_MORTEM] });
    expect(distill.status).toBe(404);
    const list = await f.http.get('/v1/admin/strategy').set(auth());
    expect(list.status).toBe(404);
    const patch = await f.http
      .patch('/v1/admin/strategy/some-id')
      .set(auth())
      .send({ status: 'active' });
    expect(patch.status).toBe(404);
  });

  it('the DI-level retrieve serves nothing (master off)', async () => {
    const svc = f.app.get(StrategyMemoryService);
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.retrieve(f.companyId, 'anything')).toEqual([]);
  });
});

describe('strategy lane — master on, retrieval off', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    clearStrategyEnv();
    process.env.STRATEGY_MEMORY_ENABLED = '1';
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    f = await createApp();
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'strategy_e2e_tenant' },
      predicate: 'status',
      object: 'engineer',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
  });
  afterAll(async () => {
    clearStrategyEnv();
    if (f) await f.close();
  });

  it('distill lands ≤3 dedup-merged candidate items; re-distill NOOPs', async () => {
    const distiller = f.app.get(StrategyDistillService);
    mockDistillOpenAi(distiller, [DISTILLED]);
    const first = await f.http
      .post('/v1/admin/strategy/distill')
      .set(auth())
      .send({ postMortems: [POST_MORTEM], runId: 'run-1' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      companyId: f.companyId,
      postMortems: 1,
      proposed: 1,
      added: 1,
      updated: 0,
      noop: 0,
    });

    // Same batch again: the dedup-merge arbiter (scripted NOOP after
    // the proposal) keeps the table at one row.
    mockDistillOpenAi(distiller, [DISTILLED, '{"action":"NOOP"}']);
    const second = await f.http
      .post('/v1/admin/strategy/distill')
      .set(auth())
      .send({ postMortems: [POST_MORTEM], runId: 'run-2' });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ added: 0, updated: 0, noop: 1 });

    const list = await f.http.get('/v1/admin/strategy').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.strategies).toHaveLength(1);
    expect(list.body.strategies[0]).toMatchObject({
      title: 'trust the computed date table',
      status: 'candidate',
      polarity: 'do',
    });
    expect(list.body.strategies[0].evidence.runIds).toEqual(['run-1']);
  });

  it('PATCH flips candidate → active; the status filter serves it', async () => {
    const list = await f.http.get('/v1/admin/strategy').set(auth());
    const id = list.body.strategies[0].strategyId as string;
    const patch = await f.http
      .patch(`/v1/admin/strategy/${encodeURIComponent(id)}`)
      .set(auth())
      .send({ status: 'active' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('active');
    const active = await f.http
      .get('/v1/admin/strategy?status=active')
      .set(auth());
    expect(active.body.strategies).toHaveLength(1);
    const candidates = await f.http
      .get('/v1/admin/strategy?status=candidate')
      .set(auth());
    expect(candidates.body.strategies).toHaveLength(0);
  });

  it('serving stays OFF: no ADVISORY section reaches the generator', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer' });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThan(0);
    for (const call of state.calls) {
      expect(call.user).not.toContain('ADVISORY STRATEGY NOTES');
      expect(call.user).not.toContain('trust the computed date table');
    }
  });
});

describe('strategy lane — both flags on (serving)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const STRATEGY_TEXT =
    'Derive elapsed intervals from the computed date table rather than freehand arithmetic.';

  beforeAll(async () => {
    clearStrategyEnv();
    process.env.STRATEGY_MEMORY_ENABLED = '1';
    process.env.STRATEGY_RETRIEVAL_ENABLED = '1';
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    f = await createApp();
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'strategy_e2e_tenant2' },
      predicate: 'status',
      object: 'engineer',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
    // Seed an ACTIVE item at the service level (manual/API seeding is
    // the v1 source; DI keeps the LLM out of the seed path). The item
    // embeds `${title}\n${situation}` — with an empty situation the
    // StubEmbedder trims to exactly the query text, so the cosine is
    // 1.0 and the default 0.4 floor passes (identical-text property;
    // the floor semantics themselves are unit-pinned).
    await f.app.get(StrategyMemoryService).create(f.companyId, {
      title: 'engineer',
      situation: '',
      strategy: STRATEGY_TEXT,
      polarity: 'do',
      status: 'active',
    });
  });
  afterAll(async () => {
    clearStrategyEnv();
    if (f) await f.close();
  });

  it('the generator sees the fenced ADVISORY note; the verifier does NOT (parity exception)', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer' });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThanOrEqual(2);
    const generatorCall = state.calls[0];
    expect(generatorCall.user).toContain('=== ADVISORY STRATEGY NOTES');
    expect(generatorCall.user).toContain(STRATEGY_TEXT);
    expect(generatorCall.user).toContain('=== END ADVISORY STRATEGY NOTES ===');
    // Every later call in this flow is the verifier: advisory content
    // must be absent from ALL of them.
    for (const call of state.calls.slice(1)) {
      expect(call.user).not.toContain('ADVISORY STRATEGY NOTES');
      expect(call.user).not.toContain(STRATEGY_TEXT);
    }
  });

  it('LEAKAGE: a strategy item matching the query contaminates no search result and no citation', async () => {
    // Seed a strategy whose embedded text EQUALS the query — identical
    // text gives cosine 1.0 under the StubEmbedder, so if strategy
    // rows could enter a fact lane at all, this would be the top hit.
    const query = 'the sale happened three weeks before the visit';
    await f.app.get(StrategyMemoryService).create(f.companyId, {
      title: query,
      situation: '',
      strategy: query,
      polarity: 'do',
      status: 'active',
    });

    const search = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query });
    expect(search.status).toBe(201);
    const body = JSON.stringify(search.body);
    expect(body).not.toContain('strategy_memory');
    for (const hit of search.body.results ?? []) {
      for (const fact of hit.facts ?? []) {
        expect(String(fact.object)).not.toBe(query);
        expect(String(fact.factId)).not.toContain('strategy_memory');
      }
    }

    // Synthesize on the same query: citations may only ever point at
    // knowledge_fact rows — never at the strategy table.
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'no evidence', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const synth = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer' });
    expect(synth.status).toBe(201);
    expect(JSON.stringify(synth.body.citations ?? [])).not.toContain(
      'strategy_memory',
    );
    // The strategy text may appear ONLY inside the fenced advisory
    // section of the generator prompt — never among the fact lines.
    const generatorCall = state.calls[0];
    const factSection = generatorCall.user.split(
      '=== ADVISORY STRATEGY NOTES',
    )[0];
    expect(factSection).not.toContain(query);
  });
});
