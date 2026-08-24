/**
 * Trajectory trap shakedown — the MemTrap "Cognitive-Bias / Trauma
 * fixation" exposure of a TRAJECTORY-BEARING strategy memory (bet #3,
 * Part 3; mirrors test/memtrap-shakedown.e2e-spec.ts scenario 2).
 *
 * WHY A DEDICATED SCENARIO. A bare advice string already reaches the
 * generator invisibly to the verifier (memtrap scenario 2). A trajectory-
 * bearing item is MORE exposed: it additionally carries a CONCRETE PAST
 * PATH (a specific tool sequence that worked once) that can misfire on a
 * surface-similar but genuinely different task — the essence of Cognitive-
 * Bias fixation. This suite maps that exposure precisely and gates it
 * against regression.
 *
 * WHAT IT CAN AND CANNOT DO — read before extending. The generator +
 * verifier are SCRIPTED stubs and the embedder is a deterministic double;
 * this suite therefore makes NO accuracy/quality claim about whether a
 * real model is actually misled. It is a PLUMBING + posture diagnostic:
 * it asserts (a) the trap trajectory reaches the GENERATOR advisory (the
 * fixation carrier) and (b) our current STRUCTURAL posture holds — the
 * trajectory stays OUT of the verifier bundle and citations (the G4
 * verifier-parity exception is inviolable). Under the stub embedder the
 * strategy's retrieval key is made to coincide with the spring query to
 * model embedding proximity between two surface-similar tasks
 * deterministically; the plumbing finding is independent of why retrieval
 * matched.
 *
 * MITIGATIONS (documented, NOT asserted here — they are the enabling
 * pre-reqs, not this suite's subject): serving trajectory memory should
 * ride the §4.3 lens-suppression governor + the verifier answer-integrity
 * arm (FOVEA_PLAUSIBILITY_CHECK / require-citations). This suite only
 * pins the posture those arms are meant to harden.
 *
 * VERDICT: EXPOSED (invisible to the verifier) — same class as memtrap
 * scenario 2, now with a concrete past path amplifying the fixation. No
 * structural defense in the base pipeline catches a trajectory-induced
 * fixation; that is the honest posture, asserted, not papered over.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { StrategyMemoryService } from '../src/strategy/strategy-memory.service';

const FLAG_ENV: Record<string, string> = {
  SYNTHESIZE_ANSWER_ROUTER_ENABLED: '1',
  STRATEGY_MEMORY_ENABLED: '1',
  STRATEGY_RETRIEVAL_ENABLED: '1',
  STRATEGY_TRAJECTORIES_ENABLED: '1',
  // Keep abstention off so a thin-evidence query never pre-abstains before
  // generation — deterministic generate+verify pair (2 LLM calls).
  RETRIEVAL_ABSTENTION_CALIBRATION: 'off',
};

describe('trajectory trap shakedown (Cognitive-Bias fixation, trajectory-bearing)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  // The A-task past path that SUCCEEDED once and is now over-applied to a
  // surface-similar B-task. The trap lives in both the advice AND the
  // concrete tool path it carries.
  const SPRING_QUERY = 'crimson-widget calibration puzzle';
  const TRAP_STRATEGY =
    'Reuse the single-shot cached-estimate path that worked before: read the cache and stop.';
  let biasFactId: string;

  beforeAll(async () => {
    for (const k of Object.keys(FLAG_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = FLAG_ENV[k]!;
    }
    f = await createApp({ companyId: 'co_traj_trap_e2e' });

    // A grounding fact for the B-task, user-scoped for isolation.
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'prob_bias_traj' },
        predicate: 'ledger',
        object: 'crimson-widget calibration puzzle',
        validFrom: new Date('2026-04-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        userId: 'u_traj_bias',
      });
    expect([200, 201]).toContain(r.status);
    biasFactId = r.body.factId as string;

    // Seed the trajectory-bearing trap item. Retrieval key (title, empty
    // situation) == the spring query ⇒ served for exactly that query. The
    // trajectory is a concrete cached-only path that "verified success"
    // for the A-task — precisely what makes it misfire on B.
    await f.app.get(StrategyMemoryService).create(f.companyId, {
      title: SPRING_QUERY,
      situation: '',
      strategy: TRAP_STRATEGY,
      polarity: 'do',
      status: 'active',
      trajectory: [
        {
          tool: 'cache_read',
          argsDigest: 'aaaabbbbccccdddd',
          resultDigest: 'eeeeffff00001111',
          ok: true,
        },
      ],
      verifiedOutcome: 'success',
    });
  });

  afterAll(async () => {
    for (const k of Object.keys(FLAG_ENV)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (f) await f.close();
  });

  it('the trap trajectory reaches the generator but never the verifier or citations (EXPOSED, verifier-blind)', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: 'Calibration resolved via the crimson-widget calibration puzzle record.',
        citedFactIds: [biasFactId],
      }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [], questionAnswered: true }),
    ]);
    const r = await f.http.post('/v1/synthesize').set(auth()).send({
      query: SPRING_QUERY,
      userId: 'u_traj_bias',
    });
    expect(r.status).toBe(201);
    expect(r.body.answer).toBeTruthy();
    expect(state.calls.length).toBe(2);
    expect(r.body.citations?.[0]?.factId).toBe(biasFactId);

    const PAST_PATH = '[past tool path: cache_read(ok), verified success]';

    // (a) FIXATION CARRIER: the trap strategy AND its concrete past path
    // reached the GENERATOR prompt, in the fenced advisory section.
    expect(state.calls[0]!.user).toContain('=== ADVISORY STRATEGY NOTES');
    expect(state.calls[0]!.user).toContain(TRAP_STRATEGY);
    expect(state.calls[0]!.user).toContain(PAST_PATH);

    // (b) POSTURE HELD: by the G4 parity exception the note — advice AND
    // trajectory — is DELIBERATELY absent from the verifier's evidence
    // bundle, so a trajectory-induced fixation is structurally invisible
    // to the grounding audit (the exposure this scenario documents).
    expect(state.calls[1]!.user).not.toContain('ADVISORY STRATEGY NOTES');
    expect(state.calls[1]!.user).not.toContain(TRAP_STRATEGY);
    expect(state.calls[1]!.user).not.toContain('past tool path');

    // (c) It is never a citation — advice-with-experience is not evidence.
    expect(JSON.stringify(r.body.citations ?? [])).not.toContain(TRAP_STRATEGY);
    expect(JSON.stringify(r.body.citations ?? [])).not.toContain('past tool path');
    expect(JSON.stringify(r.body.citations ?? [])).not.toContain('strategy_memory');
    // (a)+(b)+(c) ⇒ EXPOSED. Honest posture: the base pipeline carries the
    // trajectory to the generator and cannot catch its fixation at the
    // verifier; §4.3 suppression + the verifier answer-integrity arm are
    // the intended (separately-gated) mitigations, not asserted here.
  });
});
