/**
 * Strategy trajectories e2e — the experience-memory extension of G4
 * (bet #3, Part 3 of docs/roadmap/measurable-economics-mri-2026-08.md).
 *
 *   1. Trajectories OFF (default), master ON → the capture endpoint 404s
 *      (no effect), /distill still works, and a served plain item is
 *      BYTE-IDENTICAL (no "past tool path" in the prompt) — the flag-off
 *      guarantee.
 *   2. All ON → a completed tool-run + outcome distills into a
 *      trajectory-bearing item through the SAME Mem0 dedup (ADD → NOOP →
 *      UPDATE); DIGESTS, not raw payloads, are stored (a planted secret
 *      never lands in the row).
 *   3. All ON, serving → the trajectory reaches the GENERATOR advisory
 *      section but NEVER the verifier bundle and NEVER citations (the G4
 *      verifier-parity exception, now carrying an experience).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { StrategyMemoryService } from '../src/strategy/strategy-memory.service';
import { StrategyDistillService } from '../src/strategy/strategy-distill.service';
import { digestPayload } from '../src/strategy/trajectory-digest';

const STRATEGY_ENV_KEYS = [
  'STRATEGY_MEMORY_ENABLED',
  'STRATEGY_RETRIEVAL_ENABLED',
  'STRATEGY_TRAJECTORIES_ENABLED',
  'STRATEGY_SIMILARITY_FLOOR',
  'SYNTHESIZE_ANSWER_ROUTER_ENABLED',
];

function clearStrategyEnv(): void {
  for (const k of STRATEGY_ENV_KEYS) delete process.env[k];
}

/** Scripted OpenAI stub for the distiller (the mockSynthesizeOpenAi idiom). */
function mockDistillOpenAi(svc: StrategyDistillService, responses: string[]): { calls: number } {
  const state = { calls: 0 };
  const stub = {
    chat: {
      completions: {
        create: async () => {
          const content = responses[state.calls] ?? responses[responses.length - 1] ?? '{}';
          state.calls++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  (svc as unknown as { openai: typeof stub }).openai = stub;
  return state;
}

const distilledItem = (over: Partial<Record<string, string>> = {}): string =>
  JSON.stringify({
    items: [
      {
        title: over.title ?? 'onboarding lookup strategy',
        situation: over.situation ?? '',
        strategy:
          over.strategy ??
          'When onboarding-status is asked, check the profile record first — the direct lookup resolved it here.',
        polarity: over.polarity ?? 'do',
      },
    ],
  });

const ingestFact = async (f: AppFixture, id: string): Promise<void> => {
  await f.http
    .post('/v1/ingest/fact')
    .set({ Authorization: `Bearer ${f.apiKey}` })
    .send({
      entityRef: { vertical: 'rent', id },
      predicate: 'status',
      object: 'engineer',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
};

// ── 1. Trajectories OFF (default): capture 404s, serving byte-identical ───

describe('strategy trajectories — flag OFF (default), master ON', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const STRATEGY_TEXT = 'Check the profile record first for onboarding-status questions.';

  beforeAll(async () => {
    clearStrategyEnv();
    process.env.STRATEGY_MEMORY_ENABLED = '1';
    process.env.STRATEGY_RETRIEVAL_ENABLED = '1';
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    // STRATEGY_TRAJECTORIES_ENABLED deliberately unset → off.
    f = await createApp();
    await ingestFact(f, 'traj_off_tenant');
    // Even if a trajectory is passed, the flag-off create MUST NOT write
    // it (the service-side gate) — proving no trajectory column on the
    // off path regardless of caller input.
    await f.app.get(StrategyMemoryService).create(f.companyId, {
      title: 'engineer',
      situation: '',
      strategy: STRATEGY_TEXT,
      polarity: 'do',
      status: 'active',
      trajectory: [{ tool: 'should_not_persist', argsDigest: 'x', resultDigest: 'y', ok: true }],
      verifiedOutcome: 'success',
    });
  });
  afterAll(async () => {
    clearStrategyEnv();
    if (f) await f.close();
  });

  it('the capture endpoint 404s — indistinguishable from not deployed', async () => {
    const r = await f.http
      .post('/v1/admin/strategy/trajectory')
      .set(auth())
      .send({
        task: 'resolve onboarding status',
        outcome: 'success',
        steps: [{ tool: 'lookup', args: { id: 1 }, result: { ok: true }, ok: true }],
      });
    expect(r.status).toBe(404);
  });

  it('serving is BYTE-IDENTICAL: the advisory note carries no trajectory', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http.post('/v1/synthesize').set(auth()).send({ query: 'engineer' });
    expect(res.status).toBe(201);
    const generatorCall = state.calls[0]!;
    // The classic advisory note serves; the trajectory the caller tried to
    // attach was never written and never renders.
    expect(generatorCall.user).toContain('=== ADVISORY STRATEGY NOTES');
    expect(generatorCall.user).toContain(STRATEGY_TEXT);
    expect(generatorCall.user).not.toContain('past tool path');
    expect(generatorCall.user).not.toContain('should_not_persist');
  });
});

// ── 2 + 3. All ON: capture (ADD/NOOP/UPDATE, digests) + generator-only ────

describe('strategy trajectories — all flags ON', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const SECRET = 'sk-live-SUPER-SECRET-9f8e7d';
  const RAW_ARGS = { apiKey: SECRET, endpoint: 'https://api.example/profile' };
  const RAW_RESULT = { status: 200, body: 'user-private-record-ZZZ' };

  beforeAll(async () => {
    clearStrategyEnv();
    process.env.STRATEGY_MEMORY_ENABLED = '1';
    process.env.STRATEGY_RETRIEVAL_ENABLED = '1';
    process.env.STRATEGY_TRAJECTORIES_ENABLED = '1';
    process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED = '1';
    f = await createApp();
    await ingestFact(f, 'traj_on_tenant');
  });
  afterAll(async () => {
    clearStrategyEnv();
    if (f) await f.close();
  });

  it('captures a tool-run as a trajectory-bearing item; DIGESTS (not raw payloads) are stored', async () => {
    const distiller = f.app.get(StrategyDistillService);
    // Empty table → ADD (proposal only; no neighbors → no merge call).
    mockDistillOpenAi(distiller, [distilledItem({ title: 'onboarding lookup strategy' })]);
    const add = await f.http
      .post('/v1/admin/strategy/trajectory')
      .set(auth())
      .send({
        runId: 'run-t1',
        task: 'resolve the user onboarding status',
        outcome: 'success',
        outcomeEvidenceRef: 'eval:run-t1#q3',
        steps: [
          { tool: 'profile_lookup', args: RAW_ARGS, result: RAW_RESULT, ok: true },
          { tool: 'status_check', args: { id: 42 }, result: { onboarded: true }, ok: true },
        ],
      });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ steps: 2, proposed: 1, added: 1, updated: 0, noop: 0 });

    // Read the stored item back through the service (list() omits the
    // trajectory columns by design; findSimilar selects them when the
    // flag is on). Assert digests, never the raw secret.
    const strategy = f.app.get(StrategyMemoryService);
    const found = await strategy.findSimilar(f.companyId, 'onboarding lookup strategy');
    expect(found.length).toBeGreaterThanOrEqual(1);
    const item = found[0]!;
    expect(item.verifiedOutcome).toBe('success');
    expect(item.outcomeEvidenceRef).toBe('eval:run-t1#q3');
    expect(item.trajectory).toBeDefined();
    expect(item.trajectory!).toHaveLength(2);
    const [s0] = item.trajectory!;
    expect(s0!.tool).toBe('profile_lookup');
    expect(s0!.ok).toBe(true);
    // The digest is the deterministic hash — and the raw secret/PII is
    // NOWHERE in the stored row.
    expect(s0!.argsDigest).toBe(digestPayload(RAW_ARGS));
    expect(s0!.resultDigest).toBe(digestPayload(RAW_RESULT));
    const serialized = JSON.stringify(item.trajectory);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('user-private-record-ZZZ');
    expect(serialized).not.toContain('api.example');
  });

  it('re-capturing the same run NOOPs (dedup); a related run UPDATEs the target', async () => {
    const distiller = f.app.get(StrategyDistillService);
    const strategy = f.app.get(StrategyMemoryService);

    // Same run again: proposal (call 0) then the arbiter NOOPs (call 1).
    mockDistillOpenAi(distiller, [
      distilledItem({ title: 'onboarding lookup strategy' }),
      '{"action":"NOOP"}',
    ]);
    const noop = await f.http
      .post('/v1/admin/strategy/trajectory')
      .set(auth())
      .send({
        task: 'resolve the user onboarding status again',
        outcome: 'success',
        steps: [{ tool: 'profile_lookup', args: { id: 7 }, result: {}, ok: true }],
      });
    expect(noop.status).toBe(201);
    expect(noop.body).toMatchObject({ added: 0, updated: 0, noop: 1 });

    // A related run that the arbiter merges into the existing item.
    const existing = await strategy.findSimilar(f.companyId, 'onboarding lookup strategy');
    const targetId = existing[0]!.strategyId;
    mockDistillOpenAi(distiller, [
      distilledItem({ title: 'onboarding lookup strategy v2' }),
      JSON.stringify({
        action: 'UPDATE',
        targetId,
        strategy: 'Check the profile record first for onboarding-status questions.',
        situation: '',
      }),
    ]);
    const upd = await f.http
      .post('/v1/admin/strategy/trajectory')
      .set(auth())
      .send({
        task: 'confirm onboarding completion',
        outcome: 'failure',
        steps: [{ tool: 'profile_lookup', args: { id: 9 }, result: {}, ok: false }],
      });
    expect(upd.status).toBe(201);
    expect(upd.body).toMatchObject({ added: 0, updated: 1, noop: 0 });

    // The UPDATE attached the newest experience (failure outcome) to the
    // merged target — dedup grew evidence, not the table.
    const list = await f.http.get('/v1/admin/strategy').set(auth());
    expect(list.body.strategies).toHaveLength(1);
    const merged = await strategy.findSimilar(f.companyId, 'onboarding lookup strategy');
    expect(merged[0]!.verifiedOutcome).toBe('failure');
  });

  it('a captured trajectory reaches the GENERATOR advisory but NOT the verifier or citations', async () => {
    // Seed an ACTIVE trajectory-bearing item whose retrieval key == the
    // query (StubEmbedder identical-text ⇒ cosine 1.0), so it is served.
    const strategy = f.app.get(StrategyMemoryService);
    const NOTE_STRATEGY = 'Prefer the direct profile lookup for status questions.';
    await strategy.create(f.companyId, {
      title: 'engineer',
      situation: '',
      strategy: NOTE_STRATEGY,
      polarity: 'do',
      status: 'active',
      trajectory: [
        {
          tool: 'profile_lookup',
          argsDigest: 'deadbeefdeadbeef',
          resultDigest: 'cafecafecafecafe',
          ok: true,
        },
        {
          tool: 'status_check',
          argsDigest: 'f00df00df00df00d',
          resultDigest: '0ff00ff00ff00ff0',
          ok: true,
        },
      ],
      verifiedOutcome: 'success',
    });
    const PAST_PATH = '[past tool path: profile_lookup(ok) → status_check(ok), verified success]';

    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http.post('/v1/synthesize').set(auth()).send({ query: 'engineer' });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThanOrEqual(2);

    // (a) The trajectory rendered into the fenced advisory for the GENERATOR.
    const generatorCall = state.calls[0]!;
    expect(generatorCall.user).toContain('=== ADVISORY STRATEGY NOTES');
    expect(generatorCall.user).toContain(NOTE_STRATEGY);
    expect(generatorCall.user).toContain(PAST_PATH);

    // (b) The verifier-parity exception STAYS: no later (verifier) call
    // sees the advisory OR the trajectory.
    for (const call of state.calls.slice(1)) {
      expect(call.user).not.toContain('ADVISORY STRATEGY NOTES');
      expect(call.user).not.toContain(NOTE_STRATEGY);
      expect(call.user).not.toContain('past tool path');
    }
    // (c) Never a citation — advice (with experience) is not evidence.
    expect(JSON.stringify(res.body.citations ?? [])).not.toContain('strategy_memory');
    expect(JSON.stringify(res.body.citations ?? [])).not.toContain('past tool path');
  });
});
