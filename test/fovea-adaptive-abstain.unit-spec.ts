/**
 * Fovea optics (Optics §4.2, docs/roadmap/fovea-optics-2026-08.md §4.2) —
 * unit coverage of:
 *   1. the pure coverage-abstention decision (verdict.ts:coverageAbstention)
 *      — adaptive present: abstain iff calibrated confidence < threshold;
 *      absent: the static coverage floor, byte-identical to today. The
 *      abstentionCalibration!=='coverage' early return and the guardrails
 *      strict/lenient gate hold unconditionally on both paths.
 *   2. stage-scoped fit/load (focus-signal.service.ts) — the 'preanswer' and
 *      'verdict' populations are NEVER pooled; loadCalibration defaults to
 *      'verdict' (Optics-2's stage-less call is byte-identical); a stage with
 *      no samples yields no usable model.
 */
import { coverageAbstention, type AbstainAdaptiveGate } from '../src/synthesize/verdict';
import { NOT_IN_MEMORY_ANSWER } from '../src/synthesize/abstention';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';
import type { RetrievalProfile } from '../src/search/retrieval-profile';
import type { SynthesisGuardrails } from '../src/synthesize/dto/synthesize.dto';
import type { SearchHit } from '../src/search/search.types';
import type { SynthesizeResult } from '../src/synthesize/synthesize.types';
import { FocusSignalService } from '../src/synthesize/focus-signal.service';
import { applyMap } from '../src/ai/calibration/isotonic';
import { hasUsableCalibration } from '../src/synthesize/focus-signal';
import type { SurrealService } from '../src/db/surreal.service';

// ── fixtures ────────────────────────────────────────────────────────
function hit(scores: number[]): SearchHit {
  return {
    entityId: 'knowledge_entity:e1',
    entityType: 'person',
    canonicalName: 'E1',
    externalRefs: {},
    score: Math.max(...scores, 0),
    facts: scores.map((s, i) => ({
      factId: `knowledge_fact:f${i}`,
      predicate: 'work',
      object: `fact ${i}`,
      confidence: 0.85,
      validFrom: '2026-01-01T00:00:00.000Z',
      status: 'active' as const,
      score: s,
    })),
  };
}

/** Floors 0.35/2. COVERED = topScore ≥ 0.35 AND ≥ 2 facts. */
const COVERED = [hit([0.6, 0.4])]; // top 0.6, 2 facts → covered
const UNCOVERED = [hit([0.2, 0.1])]; // top 0.2 < 0.35 → not covered

function coverageProfile(): RetrievalProfile {
  return resolveRetrievalProfile({
    RETRIEVAL_ABSTENTION_CALIBRATION: 'coverage',
  } as NodeJS.ProcessEnv);
}
function verifierProfile(): RetrievalProfile {
  return resolveRetrievalProfile({
    RETRIEVAL_ABSTENTION_CALIBRATION: 'verifier',
  } as NodeJS.ProcessEnv);
}

interface DepsCapture {
  deps: Parameters<typeof coverageAbstention>[0];
  synth: string[];
  paths: string[];
}
function fakeDeps(): DepsCapture {
  const synth: string[] = [];
  const paths: string[] = [];
  return {
    synth,
    paths,
    deps: {
      metrics: {
        countSynthesize: ((o: string) => synth.push(o)) as never,
        countAbstainPath: (p: 'adaptive' | 'static') => paths.push(p),
        countPlausibilityDowngrade: () => {},
        countCitationGuardAbstain: () => {},
        countEvidenceCapability: () => {},
      },
      logger: { debug: () => {} },
    },
  };
}

// ── 1. the pure decision ────────────────────────────────────────────
describe('coverageAbstention — Optics §4.2 adaptive gate replaces the floor', () => {
  it('adaptive + confidence < threshold → abstains (even when coverage WOULD pass)', () => {
    const { deps, synth, paths } = fakeDeps();
    const adaptive: AbstainAdaptiveGate = { confidence: 0.2, threshold: 0.5 };
    const r = coverageAbstention(deps, {
      profile: coverageProfile(),
      guardrails: 'lenient',
      results: COVERED, // static path would PROCEED here — isolates the gate
      explain: false,
      adaptive,
    });
    expect(r?.answer).toBe(NOT_IN_MEMORY_ANSWER);
    expect(r?.reason).toBe('low_coverage');
    expect(r?.citations).toEqual([]);
    expect(synth).toEqual(['low_coverage']);
    expect(paths).toEqual(['adaptive']);
  });

  it('adaptive + confidence ≥ threshold → proceeds (even when coverage WOULD fail)', () => {
    const { deps, synth, paths } = fakeDeps();
    const r = coverageAbstention(deps, {
      profile: coverageProfile(),
      guardrails: 'lenient',
      results: UNCOVERED, // static path would ABSTAIN here — isolates the gate
      explain: false,
      adaptive: { confidence: 0.9, threshold: 0.5 },
    });
    expect(r).toBeNull();
    expect(synth).toEqual([]);
    expect(paths).toEqual([]);
  });

  it('adaptive absent → static floor: covered proceeds, uncovered abstains (path=static)', () => {
    {
      const { deps } = fakeDeps();
      expect(
        coverageAbstention(deps, {
          profile: coverageProfile(),
          guardrails: 'strict',
          results: COVERED,
          explain: false,
        }),
      ).toBeNull();
    }
    {
      const { deps, synth, paths } = fakeDeps();
      const r = coverageAbstention(deps, {
        profile: coverageProfile(),
        guardrails: 'strict',
        results: UNCOVERED,
        explain: false,
      });
      expect(r?.answer).toBe(NOT_IN_MEMORY_ANSWER);
      expect(synth).toEqual(['low_coverage']);
      expect(paths).toEqual(['static']);
    }
  });

  it('abstentionCalibration !== "coverage" → null on BOTH paths (adaptive is inert)', () => {
    const low: AbstainAdaptiveGate = { confidence: 0.01, threshold: 0.5 };
    for (const adaptive of [undefined, low]) {
      const { deps, synth, paths } = fakeDeps();
      const r = coverageAbstention(deps, {
        profile: verifierProfile(),
        guardrails: 'lenient',
        results: UNCOVERED,
        explain: false,
        ...(adaptive ? { adaptive } : {}),
      });
      expect(r).toBeNull();
      expect(synth).toEqual([]);
      expect(paths).toEqual([]);
    }
  });

  it('guardrails off/answer → null on BOTH paths (abstention not permitted)', () => {
    const low: AbstainAdaptiveGate = { confidence: 0.01, threshold: 0.5 };
    for (const guardrails of ['off', 'answer'] as SynthesisGuardrails[]) {
      for (const adaptive of [undefined, low]) {
        const { deps } = fakeDeps();
        expect(
          coverageAbstention(deps, {
            profile: coverageProfile(),
            guardrails,
            results: UNCOVERED,
            explain: false,
            ...(adaptive ? { adaptive } : {}),
          }),
        ).toBeNull();
      }
    }
  });

  it('no adaptive gate → byte-identical to the static coverage decision (safety sweep)', () => {
    // For every shared input, omitting `adaptive` (and passing it explicitly
    // undefined) reproduces the static outcome exactly — the load-bearing
    // fallback property at the decision core.
    const norm = (r: SynthesizeResult | null) =>
      r === null ? null : { a: r.answer, reason: r.reason };
    for (const profile of [coverageProfile(), verifierProfile()]) {
      for (const guardrails of ['strict', 'lenient', 'off', 'answer'] as SynthesisGuardrails[]) {
        for (const results of [COVERED, UNCOVERED]) {
          const base = { profile, guardrails, results, explain: false };
          const a = coverageAbstention(fakeDeps().deps, base);
          const b = coverageAbstention(fakeDeps().deps, { ...base, adaptive: undefined });
          expect(norm(b)).toEqual(norm(a));
        }
      }
    }
  });
});

// ── 2. stage-scoped fit/load (no pooling) ───────────────────────────
type SampleRow = {
  queryClass: string;
  topScore: number;
  coverageScore: number;
  verifierVerdict: string;
  retrievalGap: number;
  correct: number;
};
type CalRow = {
  queryClass: string;
  stage: string;
  thresholds: number[];
  values: number[];
  sampleCount: number;
  version: number;
};

function sampleSet(correct: 0 | 1, verdict: string): SampleRow[] {
  return Array.from({ length: 6 }, (_v, i) => {
    const x = (i + 0.5) / 6;
    return {
      queryClass: 'default',
      topScore: x,
      coverageScore: x,
      verifierVerdict: verdict,
      retrievalGap: x,
      correct,
    };
  });
}

/** A fake Surreal that interprets the service's stage-filtered queries and
 *  keeps persisted calibration rows in memory so loadCalibration can read
 *  them back. Stage is inferred from the query's predicate. */
function fakeSurreal(samples: { verdict: SampleRow[]; preanswer: SampleRow[] }): {
  surreal: SurrealService;
  persisted: CalRow[];
} {
  const persisted: CalRow[] = [];
  const db = {
    query: async (sql: string, vars?: Record<string, unknown>) => {
      const isPreanswer = sql.includes("stage = 'preanswer'");
      if (sql.includes('FROM focus_signal_sample')) {
        return [isPreanswer ? samples.preanswer : samples.verdict];
      }
      if (sql.includes('SELECT version FROM focus_calibration')) {
        const q = vars?.q as string;
        const stage = vars?.stage as string;
        const match = persisted
          .filter((r) => r.queryClass === q && r.stage === stage)
          .sort((a, b) => b.version - a.version)[0];
        return [match ? [{ version: match.version }] : []];
      }
      if (sql.includes('CREATE focus_calibration')) {
        persisted.push({
          queryClass: vars!.q as string,
          stage: vars!.stage as string,
          thresholds: vars!.t as number[],
          values: vars!.v as number[],
          sampleCount: vars!.sc as number,
          version: vars!.version as number,
        });
        return [];
      }
      if (sql.includes('FROM focus_calibration')) {
        // loadCalibration — verdict stage folds NONE too (none persisted here).
        const rows = persisted
          .filter((r) => (isPreanswer ? r.stage === 'preanswer' : r.stage === 'verdict'))
          .sort((a, b) => b.version - a.version)
          .map((r) => ({
            queryClass: r.queryClass,
            thresholds: r.thresholds,
            values: r.values,
            sampleCount: r.sampleCount,
            version: r.version,
          }));
        return [rows];
      }
      return [[]];
    },
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
  return { surreal, persisted };
}

describe('FocusSignalService stage-scoped fit/load — no pooling (§4.2)', () => {
  it('fits verdict + preanswer SEPARATELY and never pools them', async () => {
    // verdict population = always-correct → calibrator maps to ~1.
    // preanswer population = always-wrong → calibrator maps to ~0.
    const { surreal, persisted } = fakeSurreal({
      verdict: sampleSet(1, 'supported'),
      preanswer: sampleSet(0, 'none'),
    });
    const svc = new FocusSignalService(surreal);

    const summary = await svc.fitAndPersist('co1');
    expect(summary.sampleCount).toBe(12); // 6 verdict + 6 preanswer, not pooled
    // Both stages persisted their own 'default' row.
    expect(persisted.some((r) => r.stage === 'verdict' && r.queryClass === 'default')).toBe(true);
    expect(persisted.some((r) => r.stage === 'preanswer' && r.queryClass === 'default')).toBe(true);
    expect(summary.classes.some((c) => c.stage === 'verdict')).toBe(true);
    expect(summary.classes.some((c) => c.stage === 'preanswer')).toBe(true);

    // loadCalibration default = 'verdict' (Optics-2's stage-less call).
    const verdictCal = await svc.loadCalibration('co1');
    const preanswerCal = await svc.loadCalibration('co1', 'preanswer');
    expect(hasUsableCalibration(verdictCal)).toBe(true);
    expect(hasUsableCalibration(preanswerCal)).toBe(true);

    // The two calibrators are DIFFERENT — verdict→high, preanswer→low. If the
    // populations had been pooled, both would blend to the same map.
    const vHi = applyMap(verdictCal['default']!, 0.5);
    const pLo = applyMap(preanswerCal['default']!, 0.5);
    expect(vHi).toBeGreaterThan(0.9);
    expect(pLo).toBeLessThan(0.1);
    expect(vHi).not.toBeCloseTo(pLo, 5);
  });

  it('a stage with no labeled samples yields no usable model (→ static fallback)', async () => {
    const { surreal } = fakeSurreal({
      verdict: sampleSet(1, 'supported'),
      preanswer: [], // no pre-answer samples captured yet
    });
    const svc = new FocusSignalService(surreal);
    const summary = await svc.fitAndPersist('co1');
    expect(summary.sampleCount).toBe(6);
    // No preanswer row persisted → loadCalibration('preanswer') is empty →
    // not usable → the abstention gate falls back to the static coverage floor.
    const preanswerCal = await svc.loadCalibration('co1', 'preanswer');
    expect(preanswerCal).toEqual({});
    expect(hasUsableCalibration(preanswerCal)).toBe(false);
    // The verdict calibrator is unaffected (Optics-2 stays byte-identical).
    expect(hasUsableCalibration(await svc.loadCalibration('co1'))).toBe(true);
  });
});
