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
    fetchTopFacts:
      judgeOverrides.fetchTopFacts ??
      jest.fn().mockResolvedValue('- dob: 1990-01-01'),
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

describe('EntityResolverService.resolveByName', () => {
  it('returns null and touches nothing when the flag is off', async () => {
    const { svc, db, judge } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_ENABLED: '0',
    });
    expect(await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('returns null when the judge service is unavailable (no key)', async () => {
    const { svc, db } = makeService(ENABLED, { isAvailable: () => false });
    expect(await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns null when no candidate clears the cosine floor', async () => {
    const { svc, db, judge } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.7));
    expect(await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] })).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('ignores a high-cosine candidate of a different type', async () => {
    const { svc, db, judge } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.97, 'asset'));
    expect(await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] })).toBeNull();
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
    expect(judge.judge).toHaveBeenCalledWith(
      '- dob: 1990-01-01',
      '- dob: 1990-01-01',
      { cosine: 0.95 },
    );
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
    expect(await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] })).toBeNull();
  });
});
