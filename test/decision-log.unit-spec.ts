import { buildDecisionLog } from '../src/synthesize/decision-log';
import type { SearchHit } from '../src/search/search.types';

function makeHit(
  entityId: string,
  facts: Array<{
    factId: string;
    predicate: string;
    object: string;
    confidence: number;
    score: number;
    finalScore?: number;
    stages?: NonNullable<SearchHit['facts'][0]['breakdown']>['stages'];
  }>,
): SearchHit {
  return {
    entityId,
    entityType: 'person',
    canonicalName: entityId,
    externalRefs: {},
    facts: facts.map((f) => ({
      factId: f.factId,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
      validFrom: '2026-01-01',
      status: 'active',
      score: f.score,
      breakdown: {
        fusedScore: f.score,
        confidence: f.confidence,
        decay: 1,
        predBoost: 1,
        finalScore: f.finalScore ?? f.score,
        stages: f.stages ?? ['hype'],
      },
    })),
    score: Math.max(...facts.map((f) => f.score)),
  };
}

describe('buildDecisionLog', () => {
  it('picks the cited facts and explains the rest', () => {
    const hits: SearchHit[] = [
      makeHit('person:1', [
        { factId: 'f1', predicate: 'status', object: 'engineer', confidence: 0.9, score: 0.85 },
        { factId: 'f2', predicate: 'dob', object: '1990-01-01', confidence: 0.8, score: 0.5 },
      ]),
    ];
    const cited = new Set(['f1']);

    const log = buildDecisionLog(hits, cited);

    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ factId: 'f1', picked: true });
    expect(log[0].rejectReason).toBeUndefined();
    expect(log[1]).toMatchObject({ factId: 'f2', picked: false });
    expect(log[1].rejectReason).toBe('not_relevant_to_query');
  });

  it('tags backfill rows with backfill_context_only', () => {
    const hits = [
      makeHit('person:1', [
        {
          factId: 'fbf',
          predicate: 'genre',
          object: 'rock',
          confidence: 0.7,
          score: 0,
          finalScore: 0,
          stages: ['backfill'],
        },
      ]),
    ];
    const log = buildDecisionLog(hits, new Set());
    expect(log[0].rejectReason).toBe('backfill_context_only');
  });

  it('flags low-score rejections below the threshold', () => {
    const hits = [
      makeHit('person:1', [
        {
          factId: 'flow',
          predicate: 'occupation',
          object: 'baker',
          confidence: 0.05,
          score: 0.05,
          finalScore: 0.05,
        },
      ]),
    ];
    const log = buildDecisionLog(hits, new Set(), { lowScoreThreshold: 0.1 });
    expect(log[0].rejectReason).toBe('low_score');
  });

  it('flags second occurrence of a predicate as duplicate', () => {
    const hits = [
      makeHit('person:1', [
        {
          factId: 'fa',
          predicate: 'status',
          object: 'engineer',
          confidence: 0.9,
          score: 0.8,
          finalScore: 0.8,
        },
        {
          factId: 'fb',
          predicate: 'status',
          object: 'former engineer',
          confidence: 0.6,
          score: 0.4,
          finalScore: 0.4,
        },
      ]),
    ];
    const log = buildDecisionLog(hits, new Set(['fa']));
    const fb = log.find((e) => e.factId === 'fb');
    expect(fb?.rejectReason).toBe('duplicate_predicate');
  });

  it('orders picked facts before rejected, both by finalScore desc', () => {
    const hits = [
      makeHit('e1', [
        { factId: 'low_pick', predicate: 'p1', object: 'o1', confidence: 0.5, score: 0.3, finalScore: 0.3 },
        { factId: 'high_pick', predicate: 'p2', object: 'o2', confidence: 0.9, score: 0.8, finalScore: 0.8 },
        { factId: 'high_reject', predicate: 'p3', object: 'o3', confidence: 0.95, score: 0.7, finalScore: 0.7 },
      ]),
    ];
    const log = buildDecisionLog(hits, new Set(['low_pick', 'high_pick']));
    expect(log.map((e) => e.factId)).toEqual([
      'high_pick',
      'low_pick',
      'high_reject',
    ]);
  });

  it('carries provenance stages through to each entry', () => {
    const hits = [
      makeHit('e1', [
        {
          factId: 'fg',
          predicate: 'status',
          object: 'CTO',
          confidence: 0.9,
          score: 0.7,
          finalScore: 0.7,
          stages: ['graph_neighbour', 'lexical'],
        },
      ]),
    ];
    const log = buildDecisionLog(hits, new Set(['fg']));
    expect(log[0].scoreBreakdown.stages).toEqual(['graph_neighbour', 'lexical']);
  });

  it('falls back to a synthetic breakdown when one is missing', () => {
    const hits: SearchHit[] = [
      {
        entityId: 'e1',
        entityType: 'org',
        canonicalName: 'Acme',
        externalRefs: {},
        score: 0.5,
        facts: [
          {
            factId: 'f1',
            predicate: 'status',
            object: 'active',
            confidence: 0.8,
            validFrom: '2026-01-01',
            status: 'active',
            score: 0.5,
            // no breakdown
          },
        ],
      },
    ];
    const log = buildDecisionLog(hits, new Set(['f1']));
    expect(log[0].scoreBreakdown.finalScore).toBe(0.5);
    expect(log[0].scoreBreakdown.stages).toEqual([]);
  });
});
