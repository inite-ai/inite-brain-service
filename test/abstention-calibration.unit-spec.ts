import {
  assessMemoryCoverage,
  NOT_IN_MEMORY_ANSWER,
} from '../src/synthesize/abstention';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';
import { ABSTAIN_RE } from '../test/eval/abstain';
import type { SearchHit } from '../src/search/search.types';

/**
 * V9 §4 — memory-coverage abstention. The abstention ability rewards
 * refusing when memory has no answer; the pre-V9 engine delegates that
 * decision entirely to the generator, which composes plausible answers
 * from near-miss evidence (~42% on the BEAM row). Under
 * abstentionCalibration='coverage', strict/lenient synthesize requires
 * the evidence to clear a top-score + fact-count floor before
 * generation; 'answer' guardrails stay exempt (never-abstain contract).
 */

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
      status: 'active',
      score: s,
    })),
  };
}

describe('assessMemoryCoverage', () => {
  const floors = { minTopScore: 0.35, minEvidence: 2 };

  it('clears the floor when both signals pass', () => {
    const r = assessMemoryCoverage([hit([0.6, 0.2])], floors);
    expect(r).toEqual({ topScore: 0.6, factCount: 2, covered: true });
  });

  it('fails on a low top score even with many facts', () => {
    const r = assessMemoryCoverage([hit([0.2, 0.15, 0.1])], floors);
    expect(r.covered).toBe(false);
    expect(r.topScore).toBeCloseTo(0.2);
  });

  it('fails on a single fact even with a high score', () => {
    const r = assessMemoryCoverage([hit([0.9])], floors);
    expect(r.covered).toBe(false);
    expect(r.factCount).toBe(1);
  });

  it('zero floors disable the check', () => {
    const r = assessMemoryCoverage([hit([0.01])], {
      minTopScore: 0,
      minEvidence: 0,
    });
    expect(r.covered).toBe(true);
  });

  it('counts facts across hits', () => {
    const r = assessMemoryCoverage([hit([0.5]), hit([0.4])], floors);
    expect(r).toMatchObject({ factCount: 2, covered: true });
  });

  it('non-numeric scores never become the top score', () => {
    const h = hit([0.5]);
    (h.facts[0] as { score?: unknown }).score = undefined;
    const r = assessMemoryCoverage([h], { minTopScore: 0.1, minEvidence: 1 });
    expect(r.topScore).toBe(0);
    expect(r.covered).toBe(false);
  });
});

describe('the abstention answer', () => {
  it('is recognized by the shared decline-detection regex', () => {
    expect(ABSTAIN_RE.test(NOT_IN_MEMORY_ANSWER)).toBe(true);
  });
});

describe('RETRIEVAL_ABSTENTION_CALIBRATION profile point', () => {
  it('genre-preset default; coverage round-trips; garbage rejects to preset', () => {
    // The default genre (assistant_chat) presets 'verifier' — the V9
    // verdict-decline win (genre-presets.ts). Explicit env still wins.
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('verifier');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_CALIBRATION: 'off',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('off');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_GENRE: 'documents',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('off');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_CALIBRATION: 'coverage',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('coverage');
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_CALIBRATION: 'verifier',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('verifier');
    // An invalid value reads as unset, so it falls back to the genre
    // preset ('verifier' on the default genre), not to 'off'.
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_CALIBRATION: 'always',
      } as NodeJS.ProcessEnv).abstentionCalibration,
    ).toBe('verifier');
  });

  it('floors default and parse from env', () => {
    const dflt = resolveRetrievalProfile({} as NodeJS.ProcessEnv);
    expect(dflt.abstentionMinTopScore).toBeCloseTo(0.35);
    expect(dflt.abstentionMinEvidence).toBe(2);
    const tuned = resolveRetrievalProfile({
      RETRIEVAL_ABSTENTION_MIN_SCORE: '0.5',
      RETRIEVAL_ABSTENTION_MIN_EVIDENCE: '4',
    } as NodeJS.ProcessEnv);
    expect(tuned.abstentionMinTopScore).toBeCloseTo(0.5);
    expect(tuned.abstentionMinEvidence).toBe(4);
    // 0 is a valid "disable the score floor" value.
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_ABSTENTION_MIN_SCORE: '0',
      } as NodeJS.ProcessEnv).abstentionMinTopScore,
    ).toBe(0);
  });

  it('overlays per tenant via RETRIEVAL_PROFILE_OVERRIDES', () => {
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        beamco: {
          abstentionCalibration: 'coverage',
          abstentionMinTopScore: 0.42,
          abstentionMinEvidence: 3,
        },
      }),
    } as NodeJS.ProcessEnv;
    const beamco = resolveRetrievalProfileFor('beamco', env);
    expect(beamco.abstentionCalibration).toBe('coverage');
    expect(beamco.abstentionMinTopScore).toBeCloseTo(0.42);
    expect(beamco.abstentionMinEvidence).toBe(3);
    // A tenant without an overlay rides the default genre's preset
    // ('verifier' on assistant_chat — genre-presets.ts).
    expect(resolveRetrievalProfileFor('other', env).abstentionCalibration).toBe(
      'verifier',
    );
  });
});
