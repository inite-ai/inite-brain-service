import { StringRecordId } from 'surrealdb';
import {
  resolveOcclusion,
  selectFactsWithOcclusion,
  type EntityCandidates,
  type OcclusionCandidate,
  type OcclusionConfig,
} from '../src/search/internals/occlusion';
import { assembleHits } from '../src/search/internals/response-builder';
import type {
  EntityBucket,
  FactRow,
  ScoredRow,
} from '../src/search/internals/types';

function cand(
  factId: string,
  score: number,
  predicate = 'p',
  validFrom = '2023-01-01T00:00:00.000Z',
): OcclusionCandidate {
  return { factId, score, predicate, validFrom };
}

function entity(
  entityId: string,
  matched: OcclusionCandidate[],
  backfill: OcclusionCandidate[] = [],
): EntityCandidates {
  return { entityId, matched, backfill };
}

function config(
  embeddings: Record<string, number[]>,
  over: Partial<Omit<OcclusionConfig, 'embeddings'>> = {},
): OcclusionConfig {
  return {
    threshold: 0.9,
    dateGuardDays: null,
    factsPerEntity: 5,
    backfillPerPredicate: 1,
    ...over,
    embeddings: new Map(Object.entries(embeddings)),
  };
}

// [1,0] vs [0.99,0.14] → cosine ≈ 0.990 (occludes at 0.9);
// [0,1] is orthogonal to both (never occludes).
const NEAR_DUP = [0.99, 0.14];

describe('selectFactsWithOcclusion', () => {
  it('occludes a lower-ranked near-duplicate and counts it', () => {
    const { keptByEntity, stats } = selectFactsWithOcclusion(
      [entity('e1', [cand('f1', 1.0, 'p1'), cand('f2', 0.9, 'p2')])],
      config({ f1: [1, 0], f2: NEAR_DUP }),
    );
    expect([...keptByEntity.get('e1')!.matched]).toEqual(['f1']);
    expect(stats).toEqual({
      candidates: 2,
      kept: 1,
      occluded: 1,
      refilled: 0,
      missingEmbedding: 0,
    });
  });

  it('refills the freed slot with the next-ranked non-duplicate', () => {
    const { keptByEntity, stats } = selectFactsWithOcclusion(
      [
        entity('e1', [
          cand('f1', 1.0, 'p1'),
          cand('f2', 0.9, 'p2'),
          cand('f3', 0.8, 'p3'),
        ]),
      ],
      config({ f1: [1, 0], f2: NEAR_DUP, f3: [0, 1] }, { factsPerEntity: 2 }),
    );
    expect([...keptByEntity.get('e1')!.matched].sort()).toEqual(['f1', 'f3']);
    // f3 sits at per-entity index 2 ≥ cap 2 — it only rendered because
    // occlusion freed a slot.
    expect(stats.refilled).toBe(1);
    expect(stats.occluded).toBe(1);
  });

  it('occludes across entities while slot accounting stays per-entity', () => {
    const { keptByEntity, stats } = selectFactsWithOcclusion(
      [
        entity('e1', [cand('f1', 1.0, 'p1')]),
        entity('e2', [cand('f2', 0.9, 'p1'), cand('f3', 0.8, 'p2')]),
      ],
      config(
        { f1: [1, 0], f2: NEAR_DUP, f3: [0, 1] },
        { factsPerEntity: 1 },
      ),
    );
    // e1's kept fact occludes e2's near-duplicate; e2 still fills its own
    // quota from its remaining candidate.
    expect([...keptByEntity.get('e1')!.matched]).toEqual(['f1']);
    expect([...keptByEntity.get('e2')!.matched]).toEqual(['f3']);
    expect(stats.occluded).toBe(1);
  });

  it('treats facts without embeddings as visible and non-occluding', () => {
    const { keptByEntity, stats } = selectFactsWithOcclusion(
      [
        entity('e1', [
          cand('f1', 1.0, 'p1'), // no embedding
          cand('f2', 0.9, 'p2'),
          cand('f3', 0.8, 'p3'),
        ]),
      ],
      config({ f2: [1, 0], f3: [1, 0] }),
    );
    // f1 kept without an embedding; it cannot occlude f2. f3 is occluded
    // by f2 (identical vectors).
    expect([...keptByEntity.get('e1')!.matched].sort()).toEqual(['f1', 'f2']);
    expect(stats.missingEmbedding).toBe(1);
    expect(stats.occluded).toBe(1);
  });

  it('occludes at exactly the threshold, keeps just below it', () => {
    const { keptByEntity } = selectFactsWithOcclusion(
      [
        entity('e1', [
          cand('f1', 1.0, 'p1'),
          cand('f2', 0.9, 'p2'), // cosine exactly 1.0 → occluded at 1.0
          cand('f3', 0.8, 'p3'), // cosine ≈ 0.990 < 1.0 → kept
        ]),
      ],
      config({ f1: [1, 0], f2: [1, 0], f3: NEAR_DUP }, { threshold: 1.0 }),
    );
    expect([...keptByEntity.get('e1')!.matched].sort()).toEqual(['f1', 'f3']);
  });

  it('date guard blocks occlusion beyond the window and allows it within', () => {
    const far = [
      entity('e1', [
        cand('f1', 1.0, 'p1', '2023-01-01T00:00:00.000Z'),
        cand('f2', 0.9, 'p2', '2023-06-01T00:00:00.000Z'),
      ]),
    ];
    const guarded = selectFactsWithOcclusion(
      far,
      config({ f1: [1, 0], f2: [1, 0] }, { dateGuardDays: 30 }),
    );
    expect([...guarded.keptByEntity.get('e1')!.matched].sort()).toEqual([
      'f1',
      'f2',
    ]);

    const unguarded = selectFactsWithOcclusion(
      far,
      config({ f1: [1, 0], f2: [1, 0] }, { dateGuardDays: null }),
    );
    expect([...unguarded.keptByEntity.get('e1')!.matched]).toEqual(['f1']);

    const near = selectFactsWithOcclusion(
      [
        entity('e1', [
          cand('f1', 1.0, 'p1', '2023-01-01T00:00:00.000Z'),
          cand('f2', 0.9, 'p2', '2023-01-15T00:00:00.000Z'),
        ]),
      ],
      config({ f1: [1, 0], f2: [1, 0] }, { dateGuardDays: 30 }),
    );
    expect([...near.keptByEntity.get('e1')!.matched]).toEqual(['f1']);
  });

  it('an occluded matched fact does not consume the backfill predicate budget', () => {
    const { keptByEntity } = selectFactsWithOcclusion(
      [
        entity(
          'e1',
          [cand('f1', 1.0, 'p1'), cand('f2', 0.9, 'p2')],
          [cand('b1', 0, 'p2')],
        ),
      ],
      config({ f1: [1, 0], f2: NEAR_DUP, b1: [0, 1] }),
    );
    // f2 (predicate p2) was occluded → p2's budget is free for b1.
    expect(keptByEntity.get('e1')!.backfill).toEqual(['b1']);
  });
});

// ── assembleHits integration ────────────────────────────────────────────

function fact(
  partial: Partial<FactRow> & { predicate: string; object: string },
): FactRow {
  return {
    id: `knowledge_fact:${partial.predicate}_${partial.object}`,
    entityId: 'knowledge_entity:e1',
    confidence: 0.9,
    validFrom: '2023-01-01T00:00:00.000Z',
    recordedAt: '2023-01-01T00:00:00.000Z',
    status: 'active',
    source: { vertical: 'support', eventId: 'ev1' },
    entity: {
      id: 'knowledge_entity:e1',
      type: 'person',
      canonicalName: 'Ada',
      externalRefs: {},
    },
    ...partial,
  };
}

function scored(f: FactRow, score: number): ScoredRow {
  return {
    row: f as ScoredRow['row'],
    score,
    breakdown: {
      fusedScore: score,
      confidence: f.confidence,
      decay: 1,
      predBoost: 1,
      finalScore: score,
      stages: ['hype'],
    },
  };
}

function bucket(entityId: string, facts: ScoredRow[]): EntityBucket {
  return { entityId, rankScore: 1, bestScore: facts[0]?.score ?? 0, facts };
}

describe('assembleHits with occlusion', () => {
  const f1 = fact({ predicate: 'hobby', object: 'camping' });
  const f2 = fact({ predicate: 'hobby', object: 'loves camping trips' });
  const f3 = fact({ predicate: 'job', object: 'painter' });
  const b1 = fact({ predicate: 'pet', object: 'dog' });
  const base = () => ({
    topEntities: [
      bucket('knowledge_entity:e1', [
        scored(f1, 1.0),
        scored(f2, 0.9),
        scored(f3, 0.8),
      ]),
    ],
    backfillByEntity: new Map([['knowledge_entity:e1', [b1]]]),
    entityTypes: undefined,
  });

  it('zero occlusions is deep-equal to the legacy path', () => {
    const legacy = assembleHits(base());
    const occluded = assembleHits({
      ...base(),
      occlusion: {
        threshold: 0.9,
        dateGuardDays: null,
        // All orthogonal — nothing occludes.
        embeddings: new Map([
          [String(f1.id), [1, 0, 0]],
          [String(f2.id), [0, 1, 0]],
          [String(f3.id), [0, 0, 1]],
        ]),
      },
    });
    expect(occluded).toEqual(legacy);
  });

  it('suppresses the near-duplicate and pulls the freed slot forward', () => {
    let stats: unknown;
    const hits = assembleHits({
      ...base(),
      factsPerEntity: 2,
      occlusion: {
        threshold: 0.9,
        dateGuardDays: null,
        embeddings: new Map([
          [String(f1.id), [1, 0]],
          [String(f2.id), NEAR_DUP],
          [String(f3.id), [0, 1]],
        ]),
        onStats: (s) => {
          stats = s;
        },
      },
    });
    expect(hits[0].facts.map((f) => f.object)).toEqual([
      'camping',
      'painter',
    ]);
    expect(stats).toMatchObject({ occluded: 1, kept: 2 });
  });

  it('never serializes embeddings into the response', () => {
    const hits = assembleHits({
      ...base(),
      occlusion: {
        threshold: 0.9,
        dateGuardDays: null,
        embeddings: new Map([[String(f1.id), [1, 0]]]),
      },
    });
    expect(JSON.stringify(hits)).not.toContain('"embedding"');
  });
});

// ── resolveOcclusion (flag + fetch) ─────────────────────────────────────

describe('resolveOcclusion', () => {
  const ENV_KEYS = [
    'SEARCH_OCCLUSION_ENABLED',
    'SEARCH_OCCLUSION_THRESHOLD',
    'SEARCH_OCCLUSION_WINDOW',
    'SEARCH_OCCLUSION_DATE_GUARD_DAYS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const logger = () => ({ warn: jest.fn() });
  const oneBucket = () => [
    bucket('knowledge_entity:e1', [
      scored(fact({ predicate: 'hobby', object: 'camping' }), 1.0),
    ]),
  ];

  it('returns null with zero DB calls when the flag is off', async () => {
    delete process.env.SEARCH_OCCLUSION_ENABLED;
    const query = jest.fn();
    const res = await resolveOcclusion({
      db: { query } as never,
      logger: logger(),
      topEntities: oneBucket(),
      backfillByEntity: new Map(),
      factsPerEntity: 5,
    });
    expect(res).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('fetches embeddings in one INSIDE-$ids query and reads the knobs', async () => {
    process.env.SEARCH_OCCLUSION_ENABLED = '1';
    process.env.SEARCH_OCCLUSION_THRESHOLD = '0.85';
    process.env.SEARCH_OCCLUSION_DATE_GUARD_DAYS = '30';
    const factId = 'knowledge_fact:hobby_camping';
    const query = jest
      .fn()
      .mockResolvedValue([[{ id: factId, embedding: [1, 0] }]]);
    const res = await resolveOcclusion({
      db: { query } as never,
      logger: logger(),
      topEntities: oneBucket(),
      backfillByEntity: new Map(),
      factsPerEntity: 5,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [
      string,
      { ids: unknown[] },
    ];
    expect(sql).toContain('INSIDE $ids');
    expect(sql).toContain('embedding IS NOT NONE');
    expect(params.ids.every((i) => i instanceof StringRecordId)).toBe(true);
    expect(res).not.toBeNull();
    expect(res!.threshold).toBe(0.85);
    expect(res!.dateGuardDays).toBe(30);
    expect(res!.embeddings.get(factId)).toEqual([1, 0]);
  });

  it('degrades to off (null + warn) when the fetch fails', async () => {
    process.env.SEARCH_OCCLUSION_ENABLED = '1';
    const log = logger();
    const res = await resolveOcclusion({
      db: { query: jest.fn().mockRejectedValue(new Error('boom')) } as never,
      logger: log,
      topEntities: oneBucket(),
      backfillByEntity: new Map(),
      factsPerEntity: 5,
    });
    expect(res).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('skips the query entirely when there are no candidates', async () => {
    process.env.SEARCH_OCCLUSION_ENABLED = '1';
    const query = jest.fn();
    const res = await resolveOcclusion({
      db: { query } as never,
      logger: logger(),
      topEntities: [],
      backfillByEntity: new Map(),
      factsPerEntity: 5,
    });
    expect(query).not.toHaveBeenCalled();
    expect(res).toEqual({
      threshold: 0.9,
      dateGuardDays: null,
      embeddings: new Map(),
    });
  });
});
