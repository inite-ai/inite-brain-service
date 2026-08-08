import { scoreRows } from '../src/search/internals/scoring';
import type { FusedRow } from '../src/search/internals/types';
import {
  buildDeriverSystem,
  DERIVER_SALIENCE_SECTION,
} from '../src/admin/window-deriver.service';
import { resolveExtractionProfile } from '../src/ai/extraction-profile';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V8 §4 importance scoring (importance-scoring-design-2026-08.md).
 * Write side: DERIVER_SALIENCE_STAMP — the deriver grades 0-3 salience
 * per proposition, stamped as source.salience (FLEXIBLE, rides through
 * fn::resolve_fact untouched). Read side: RETRIEVAL_SALIENCE_SCORING —
 * scoreRows folds SALIENCE_WEIGHTS [0.8, 1.0, 1.1, 1.25]. Both default
 * off; the neutral grade 1 is exactly 1.0 so unstamped rows are
 * byte-identical at any setting.
 */
function row(source: unknown): FusedRow {
  return {
    id: 'knowledge_fact:x',
    entityId: 'knowledge_entity:e',
    predicate: 'work',
    object: 'test',
    confidence: 1,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: new Date().toISOString(),
    status: 'active',
    source,
    fusedScore: 1,
  } as FusedRow;
}

describe('scoreRows salience fold', () => {
  const score = (source: unknown, enabled: boolean): number =>
    scoreRows({
      rows: [row(source)],
      now: Date.now(),
      salienceScoring: enabled,
    })[0].score;

  it('off → factor exactly 1.0 regardless of the stamp', () => {
    expect(score({ salience: 3 }, false)).toBeCloseTo(score({}, false), 12);
  });

  it('folds the per-grade weights when enabled', () => {
    const neutral = score({}, true);
    expect(score({ salience: 0 }, true)).toBeCloseTo(neutral * 0.8, 12);
    expect(score({ salience: 1 }, true)).toBeCloseTo(neutral, 12);
    expect(score({ salience: 2 }, true)).toBeCloseTo(neutral * 1.1, 12);
    expect(score({ salience: 3 }, true)).toBeCloseTo(neutral * 1.25, 12);
  });

  it('unstamped / invalid grades sit on the neutral 1.0', () => {
    const neutral = score({}, true);
    expect(score(null, true)).toBeCloseTo(neutral, 12);
    expect(score({ salience: 7 }, true)).toBeCloseTo(neutral, 12);
    expect(score({ salience: -1 }, true)).toBeCloseTo(neutral, 12);
    expect(score({ salience: 1.5 }, true)).toBeCloseTo(neutral, 12);
    expect(score({ salience: 'high' }, true)).toBeCloseTo(neutral, 12);
  });

  it('surfaces the factor in the breakdown only when it bites', () => {
    const scored = scoreRows({
      rows: [row({ salience: 3 }), row({})],
      now: Date.now(),
      salienceScoring: true,
    });
    expect(scored[0].breakdown.salience).toBeCloseTo(1.25, 12);
    expect('salience' in scored[1].breakdown).toBe(false);
  });
});

describe('deriver salience prompt/schema gating', () => {
  it('off → system prompt byte-identical (no salience section)', () => {
    expect(buildDeriverSystem()).not.toContain('SALIENCE');
    expect(buildDeriverSystem({ assistantContent: true })).not.toContain(
      'SALIENCE',
    );
  });

  it('on → the salience section with the 0-3 rubric', () => {
    const sys = buildDeriverSystem({ salienceStamp: true });
    expect(sys).toContain(DERIVER_SALIENCE_SECTION);
    expect(sys).toContain('3 = identity-central');
  });
});

describe('flag plumbing', () => {
  it('DERIVER_SALIENCE_STAMP resolves through the extraction profile', () => {
    expect(
      resolveExtractionProfile({} as NodeJS.ProcessEnv).deriveSalienceStamp,
    ).toBe(false);
    expect(
      resolveExtractionProfile({
        DERIVER_SALIENCE_STAMP: '1',
      } as NodeJS.ProcessEnv).deriveSalienceStamp,
    ).toBe(true);
  });

  it('RETRIEVAL_SALIENCE_SCORING resolves + overlays per tenant', () => {
    expect(
      resolveRetrievalProfile({} as NodeJS.ProcessEnv).salienceScoring,
    ).toBe(false);
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_SALIENCE_SCORING: '1',
      } as NodeJS.ProcessEnv).salienceScoring,
    ).toBe(true);
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        salco: { salienceScoring: true },
      }),
    } as NodeJS.ProcessEnv;
    expect(resolveRetrievalProfileFor('salco', env).salienceScoring).toBe(true);
    expect(resolveRetrievalProfileFor('other', env).salienceScoring).toBe(
      false,
    );
  });
});
