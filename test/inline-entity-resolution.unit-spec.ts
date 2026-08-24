/**
 * EntityResolverService — inline entity resolution orchestration (unit).
 *
 * After the EntityJudge extraction, the resolver owns only the routing:
 * cosine candidate search (same type, above floor) → delegate the verdict
 * to the shared EntityJudgeService → reuse on "same", else create new.
 * The judge itself is mocked here and unit-tested separately.
 */
import { EntityResolverService } from '../src/ingest/entity-resolver.service';

type Cfg = Record<string, string>;

function makeService(
  cfg: Cfg,
  judgeOverrides: Partial<{
    isAvailable: () => boolean;
    fetchTopFacts: jest.Mock;
    judge: jest.Mock;
  }> = {},
): {
  svc: EntityResolverService;
  db: { query: jest.Mock };
  judge: { isAvailable: jest.Mock; fetchTopFacts: jest.Mock; judge: jest.Mock };
} {
  const config = {
    get: (k: string, d?: string) => (k in cfg ? cfg[k] : d),
  } as any;
  const embedder = { embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as any;
  const judge = {
    isAvailable: jest.fn(() => judgeOverrides.isAvailable?.() ?? true),
    fetchTopFacts: judgeOverrides.fetchTopFacts ?? jest.fn().mockResolvedValue('- dob: 1990-01-01'),
    judge: judgeOverrides.judge ?? jest.fn().mockResolvedValue('same'),
  };
  const svc = new EntityResolverService(config, embedder, judge as any);
  const db = { query: jest.fn() };
  return { svc, db, judge };
}

const ENABLED: Cfg = {
  INGEST_INLINE_RESOLUTION_ENABLED: '1',
  INGEST_INLINE_RESOLUTION_COSINE_FLOOR: '0.85',
};

function candidate(sim: number, etype = 'customer') {
  return [[{ entityId: 'knowledge_entity:x', etype, sim }]];
}

/** KNN-path rows carry the walk's cosine DISTANCE (sim = 1 − dist). */
function knnCandidate(dist: number, etype = 'customer') {
  return [[{ entityId: 'knowledge_entity:x', etype, dist }]];
}

describe('EntityResolverService.resolveByName', () => {
  it('returns null and touches nothing when the flag is off', async () => {
    const { svc, db, judge } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_ENABLED: '0',
    });
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('returns null when the judge service is unavailable (no key)', async () => {
    const { svc, db } = makeService(ENABLED, { isAvailable: () => false });
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns null when no candidate clears the cosine floor', async () => {
    const { svc, db, judge } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.7));
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('ignores a high-cosine candidate of a different type', async () => {
    const { svc, db, judge } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.97, 'asset'));
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('reuses the existing entity when the judge says "same"', async () => {
    const { svc, db, judge } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.95));
    judge.judge.mockResolvedValue('same');
    const out = await svc.resolveByName({
      db: db as any,
      name: 'Acme',
      type: 'customer',
      incomingFacts: ['dob: 1990-01-01'],
    });
    expect(out).toBe('knowledge_entity:x');
    expect(judge.judge).toHaveBeenCalledWith('- dob: 1990-01-01', '- dob: 1990-01-01', {
      cosine: 0.95,
    });
  });

  it.each(['different', 'unsure'])(
    'creates new (null) when the judge says "%s"',
    async (verdict) => {
      const { svc, db, judge } = makeService(ENABLED);
      db.query.mockResolvedValueOnce(candidate(0.95));
      judge.judge.mockResolvedValue(verdict);
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'John Smith',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
    },
  );

  it('falls back to null when a DB read throws', async () => {
    const { svc, db } = makeService(ENABLED);
    db.query.mockRejectedValue(new Error('surreal down'));
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
  });
});

describe('EntityResolverService name-candidate scan (INGEST_INLINE_RESOLUTION_HNSW)', () => {
  const sqlOf = (db: { query: jest.Mock }, call = 0): string =>
    String(db.query.mock.calls[call][0]);

  it('off → exact full-scan query (no KNN operator)', async () => {
    const { svc, db } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.95));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(sqlOf(db)).toContain("predicate = 'name'");
    expect(sqlOf(db)).toContain('embedding != NONE');
    expect(sqlOf(db)).not.toContain('<|');
  });

  it('on → KNN query over the HNSW index with the right over-fetch literals', async () => {
    const { svc, db } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_HNSW: '1',
      INGEST_INLINE_RESOLUTION_CANDIDATES: '5', // kOver = 5 × 8 = 40
    });
    // The KNN path returns the walk's cosine DISTANCE (sim = 1 − dist).
    db.query.mockResolvedValueOnce(knnCandidate(0.05));
    const out = await svc.resolveByName({
      db: db as any,
      name: 'Acme',
      type: 'customer',
      incomingFacts: [],
    });
    expect(out).toBe('knowledge_entity:x');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(sqlOf(db)).toContain('embedding <|40,100|> $q');
    expect(sqlOf(db)).toContain("predicate = 'name'");
    // A4 idiom: the projection reuses the walk's distance — a fresh
    // cosine next to the KNN operator drops the planner off the KnnScan.
    expect(sqlOf(db)).toContain('vector::distance::knn()');
    expect(sqlOf(db)).not.toContain('similarity::cosine');
    // KNN pre-filter replaces the explicit embedding-not-none guard.
    expect(sqlOf(db)).not.toContain('embedding != NONE');
  });

  it('on → over-fetch and ef are configurable', async () => {
    const { svc, db } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_HNSW: '1',
      INGEST_INLINE_RESOLUTION_CANDIDATES: '10',
      INGEST_INLINE_RESOLUTION_HNSW_OVERFETCH: '4', // kOver = 10 × 4 = 40
      INGEST_INLINE_RESOLUTION_HNSW_EF: '64',
    });
    db.query.mockResolvedValueOnce(knnCandidate(0.05));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    expect(sqlOf(db)).toContain('embedding <|40,64|> $q');
  });

  it('on → a KNN failure (e.g. no index) falls back to the exact full scan', async () => {
    const { svc, db } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_HNSW: '1',
    });
    db.query
      .mockRejectedValueOnce(new Error('There is no index supporting KNN'))
      .mockResolvedValueOnce(candidate(0.95));
    const out = await svc.resolveByName({
      db: db as any,
      name: 'Acme',
      type: 'customer',
      incomingFacts: [],
    });
    expect(out).toBe('knowledge_entity:x'); // resolved via the fallback scan
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(sqlOf(db, 0)).toContain('<|'); // first: KNN (threw)
    expect(sqlOf(db, 1)).toContain('embedding != NONE'); // second: full scan
    expect(sqlOf(db, 1)).not.toContain('<|');
  });

  it('on → cosine floor + type filter still apply to KNN candidates', async () => {
    const { svc, db, judge } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_HNSW: '1',
    });
    // Nearest is a different type; below it is one under the floor → no
    // match. KNN rows carry the walk's distance (sim = 1 − dist).
    db.query.mockResolvedValueOnce([
      [
        { entityId: 'knowledge_entity:a', etype: 'asset', dist: 0.02 },
        { entityId: 'knowledge_entity:b', etype: 'customer', dist: 0.5 },
      ],
    ]);
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
  });
});
