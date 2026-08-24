/**
 * Fovea optics (Optics §4.2, docs/roadmap/fovea-optics-2026-08.md §4.2) —
 * adaptive pre-generation memory-coverage abstention, e2e over a real
 * SurrealDB (testcontainer). Proves the load-bearing SAFETY property, not the
 * adaptive win:
 *
 *   - flag off → the static coverage-floor abstention (path="static"), and
 *   - flag on WITH NO preanswer calibration model → byte-identical response
 *     to flag off, and still the static path (path="static", never
 *     "adaptive").
 *
 * The tenant is configured for coverage abstention with an impossibly high
 * score floor (RETRIEVAL_ABSTENTION_MIN_SCORE=0.999) and no conformal floor
 * (SYNTHESIZE_MIN_CONFIDENCE=0), so any retrieved evidence trips the coverage
 * floor and the gate abstains BEFORE any generator call — no OpenAI needed.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { MetricsService } from '../src/metrics/metrics.service';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';

/**
 * Deep-copy a response body with the wall-clock-varying scoring fields removed
 * (`score`/`finalScore` carry the time-decay factor; `decay` is that factor),
 * so two runs at different instants compare equal on everything the adaptive
 * code path could actually change.
 */
const VOLATILE_KEYS = new Set(['score', 'finalScore', 'decay']);
function stripVolatileScores(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileScores);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatileScores(v);
    }
    return out;
  }
  return value;
}

describe('Fovea Optics §4.2 adaptive abstention e2e (safety fallback)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const QUERY = 'what is the plan tier for the account';
  let offBody: unknown;

  async function abstainPathCount(path: string): Promise<number> {
    const metrics = f.app.get(MetricsService);
    const { body } = await metrics.serialize();
    const m = body.match(new RegExp(`brain_abstain_path_total\\{path="${path}"\\} (\\d+)`));
    return m ? parseInt(m[1]!, 10) : 0;
  }

  async function synthesize() {
    // Queue a generator/verifier script that must NEVER be consumed — the
    // coverage gate abstains before generation. state.calls.length === 0
    // proves the pre-generation exit.
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'should-not-run', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: QUERY, limit: 5, synthesisGuardrails: 'lenient', minConfidence: 0 });
    return { res, state };
  }

  beforeAll(async () => {
    delete process.env.FOVEA_ADAPTIVE_ABSTAIN;
    delete process.env.FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD;
    // Coverage abstention with an unreachable score floor → any evidence
    // abstains; no conformal floor → evidence survives to the coverage check.
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'coverage';
    process.env.RETRIEVAL_ABSTENTION_MIN_SCORE = '0.999';
    process.env.SYNTHESIZE_MIN_CONFIDENCE = '0';
    f = await createApp();
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'acct_abstain' },
        predicate: 'tier',
        object: 'gold',
        validFrom: '2026-04-01',
        source: { vertical: 'rent', messageId: 'm_abstain' },
        confidence: 0.9,
      });
  });

  afterAll(async () => {
    delete process.env.FOVEA_ADAPTIVE_ABSTAIN;
    delete process.env.FOVEA_ADAPTIVE_ABSTAIN_THRESHOLD;
    delete process.env.RETRIEVAL_ABSTENTION_CALIBRATION;
    delete process.env.RETRIEVAL_ABSTENTION_MIN_SCORE;
    delete process.env.SYNTHESIZE_MIN_CONFIDENCE;
    if (f) await f.close();
  });

  it('flag off → static coverage abstention (no generation, path=static)', async () => {
    delete process.env.FOVEA_ADAPTIVE_ABSTAIN;
    const before = await abstainPathCount('static');
    const { res, state } = await synthesize();
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(res.body.reason).toBe('low_coverage');
    // Abstained BEFORE the generator — the scripted calls were never used.
    expect(state.calls.length).toBe(0);
    expect(await abstainPathCount('static')).toBe(before + 1);
    offBody = res.body;
  });

  it('flag on + NO preanswer model → byte-identical to static (path=static)', async () => {
    process.env.FOVEA_ADAPTIVE_ABSTAIN = '1';
    // No focus_calibration rows were ever fit for this tenant, so the adaptive
    // resolver returns undefined → the gate runs its static coverage path.
    const staticBefore = await abstainPathCount('static');
    const adaptiveBefore = await abstainPathCount('adaptive');
    const { res, state } = await synthesize();
    expect(res.status).toBe(201);
    expect(state.calls.length).toBe(0);
    // Identical to the flag-off run — modulo the wall-clock time-decay jitter
    // in the per-fact score. Two synthesize calls run at different instants, so
    // the decay factor (hence `score`/`finalScore`) differs at the ~1e-8 level
    // even between two flag-OFF runs; that jitter is not the adaptive code
    // path. Strip the time-varying scoring fields and assert the rest — the
    // abstention decision (answer/reason/citations) and every fact's identity —
    // is byte-identical.
    expect(stripVolatileScores(res.body)).toEqual(stripVolatileScores(offBody));
    // Fired via the STATIC path — the no-model fallback — never adaptive.
    expect(await abstainPathCount('static')).toBe(staticBefore + 1);
    expect(await abstainPathCount('adaptive')).toBe(adaptiveBefore);
  });
});
