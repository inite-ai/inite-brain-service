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
  // The transliterated-key neighbour scan runs FIRST and is a miss unless
  // a test says otherwise, so every case below still reaches the embedding
  // scan it was written to exercise. `sqlOf(db, 0)` is that key scan;
  // `EMB` names the embedding call after it.
  db.query.mockResolvedValueOnce([[]]);
  return { svc, db, judge };
}

const ENABLED: Cfg = {
  INGEST_INLINE_RESOLUTION_ENABLED: '1',
  INGEST_INLINE_RESOLUTION_COSINE_FLOOR: '0.85',
};

function candidate(sim: number) {
  return [[{ entityId: 'knowledge_entity:x', ename: 'Acme Corp', sim }]];
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

  it('asks the scan for the SAME type only — a different type is never a candidate', async () => {
    const { svc, db } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.97));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    const [sql, params] = db.query.mock.calls[1]!;
    expect(String(sql)).toContain('type = $type');
    expect(params).toMatchObject({ type: 'customer' });
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
    // The judge is told which scan found the candidate and both names: a
    // cross-script pair's facts are the same facts in two languages, and
    // without the names that reads as no shared evidence.
    expect(judge.judge).toHaveBeenCalledWith(
      '- dob: 1990-01-01',
      '- dob: 1990-01-01',
      expect.objectContaining({
        cosine: 0.95,
        similarity: 'embedding',
        names: { a: 'Acme Corp', b: 'Acme' },
      }),
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
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
  });
});

describe('EntityResolverService name-candidate scan', () => {
  const EMB = 1; // the embedding scan sits after the key-neighbour scan
  const sqlOf = (db: { query: jest.Mock }, call = EMB): string =>
    String(db.query.mock.calls[call][0]);

  /**
   * The scan is over the ENTITIES' own name embeddings, not over
   * `name` facts. Measured on a live tenant on 2026-09-16: 33 entities,
   * 80 facts, zero with predicate `name` — nothing on the mention path
   * writes one, so the fact scan this replaced had always searched an
   * empty set. The KNN leg over the fact index went with it.
   */
  it('scans knowledge_entity.embedding, never a name fact', async () => {
    const { svc, db } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.95));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(sqlOf(db, 0)).toContain('levenshtein'); // the key scan, a miss
    const sql = sqlOf(db);
    expect(sql).toContain('FROM knowledge_entity');
    expect(sql).toContain('vector::similarity::cosine(embedding, $q)');
    expect(sql).not.toContain('knowledge_fact');
    expect(sql).not.toContain("predicate = 'name'");
    expect(sql).not.toContain('<|'); // no KNN operator — entities are few
  });

  it('gates on width so a row from another space cannot raise for the whole query', async () => {
    const { svc, db } = makeService(ENABLED);
    db.query.mockResolvedValueOnce(candidate(0.95));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    expect(sqlOf(db)).toContain('array::len(embedding) = array::len($q)');
  });

  describe('what the candidate scan is allowed to hide from the judge', () => {
    it('fences PRIVACY on the entity — the scan is over entities, so the fence reads plainly', async () => {
      const { svc, db } = makeService(ENABLED);
      db.query.mockResolvedValueOnce(candidate(0.95));
      await svc.resolveByName({
        db: db as any,
        name: 'Acme',
        type: 'customer',
        incomingFacts: [],
      });
      const sql = sqlOf(db, EMB);
      // knowledge_entity.userId means "private to one user". The fact-scan
      // this replaced fenced knowledge_fact.userId — the SPEAKER — and on a
      // per-user tenant excluded everything.
      expect(sql).toContain('FROM knowledge_entity');
      expect(sql).toContain('userId IS NONE');
      expect(sql).toContain('mergedInto IS NONE');
    });

    it('the DEFAULT floor lets a cross-script name pair reach the judge', async () => {
      // Measured on bge-m3: the same person written in two scripts scores
      // 0.695-0.865. The old 0.85 default admitted only the Latin/Cyrillic
      // end of that range, so Arabic, CJK and Devanagari spellings were
      // refused by a number before anything looked at their facts.
      const { svc, db, judge } = makeService({ INGEST_INLINE_RESOLUTION_ENABLED: '1' });
      db.query.mockResolvedValueOnce(candidate(0.695));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'إيفان بيتروف',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:x');
      expect(judge.judge).toHaveBeenCalledTimes(1);
    });

    it('an unrelated name still never reaches the judge', async () => {
      // Different people who share nothing sit at 0.42-0.48; the floor is
      // below the true band, not below everything.
      const { svc, db, judge } = makeService({ INGEST_INLINE_RESOLUTION_ENABLED: '1' });
      db.query.mockResolvedValueOnce(candidate(0.48));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Maria Alvarez',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
    });

    it('the judge, not the cosine, refuses a near-miss name', async () => {
      // "Ivan Petrov" ~ "Иван Сидоров" = 0.712, ABOVE four of the six true
      // cross-script pairs. No threshold separates them, which is the
      // whole reason the verdict is the judge's.
      const { svc, db, judge } = makeService(
        { INGEST_INLINE_RESOLUTION_ENABLED: '1' },
        {
          judge: jest.fn().mockResolvedValue('different'),
        },
      );
      db.query.mockResolvedValueOnce(candidate(0.712));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Иван Сидоров',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
      expect(judge.judge).toHaveBeenCalledTimes(1);
    });
  });
  /**
   * The transliterated-key neighbour scan — candidate generation that a
   * string comparison can actually do. Measured on the Tier-0 corpus,
   * "thomas brandt" against the whole tenant came back 0 / 1 / 3 / 4 / 6
   * for its five spellings, in order, while bge-m3 could not separate
   * "Ivan Petrov" from "Иван Сидоров" at all.
   *
   * It RANKS. It never decides: every hit below still goes to the judge.
   */
  describe('the transliterated-key neighbour scan', () => {
    const neighbour = (dist: number, matched: string) => [
      [{ entityId: 'knowledge_entity:k', dist, matched }],
    ];
    const keyFirst = (cfg: Cfg = { INGEST_INLINE_RESOLUTION_ENABLED: '1' }) => {
      const made = makeService(cfg);
      made.db.query.mockReset(); // drop the default "key scan misses"
      return made;
    };

    it('runs BEFORE the embedding scan and spends no embedding on a hit', async () => {
      const { svc, db, judge } = keyFirst();
      db.query.mockResolvedValueOnce(neighbour(1, 'tomas brandt'));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Thomas Brandt',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:k');
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(sqlOf(db, 0)).toContain('string::distance::levenshtein');
      expect(sqlOf(db, 0)).toContain('FROM knowledge_entity');
      expect(judge.judge).toHaveBeenCalledTimes(1); // the judge still decides
      expect(judge.judge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          similarity: 'transliteration',
          names: { a: undefined, b: 'Thomas Brandt' },
        }),
      );
    });

    it('fences the scan on type, privacy and merged-away entities', async () => {
      const { svc, db } = keyFirst();
      db.query.mockResolvedValueOnce([[]]);
      db.query.mockResolvedValueOnce(candidate(0.99));
      await svc.resolveByName({
        db: db as any,
        name: 'Thomas Brandt',
        type: 'customer',
        incomingFacts: [],
      });
      const sql = sqlOf(db, 0);
      expect(sql).toContain('type = $type');
      expect(sql).toContain('userId IS NONE');
      expect(sql).toContain('mergedInto IS NONE');
      expect(db.query.mock.calls[0]![1]).toMatchObject({ key: 'thomas brandt' });
    });

    it('a far neighbour is dropped and the embedding scan still runs', async () => {
      // "ivan petrov" ~ "yfn bytrwf" is 0.64 normalised — far by edits and
      // close by meaning, which is the case the embedding still earns.
      const { svc, db } = keyFirst();
      db.query.mockResolvedValueOnce(neighbour(7, 'yfn bytrwf'));
      db.query.mockResolvedValueOnce(candidate(0.99));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Ivan Petrov',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:x'); // the EMBEDDING candidate, not the key one
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('a distance of ZERO is declined — the deterministic ladder owns that', async () => {
      // An exact key match was already tried in entity-upsert; reaching
      // here with one means it found TWO and refused to guess between them.
      const { svc, db } = keyFirst();
      db.query.mockResolvedValueOnce(neighbour(0, 'thomas brandt'));
      db.query.mockResolvedValueOnce([[]]);
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Thomas Brandt',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
    });

    it('hands a near-miss to the judge, which refuses it', async () => {
      // "ivan petrov" ~ "ivan sidorov" is 0.33 — inside the ceiling on
      // purpose, because edits cannot tell it from "aarav sharma" ~
      // "arv srma" at the same distance. Facts can.
      const { svc, db, judge } = keyFirst();
      (judge.judge as jest.Mock).mockResolvedValue('different');
      db.query.mockResolvedValueOnce(neighbour(4, 'ivan sidorov'));
      db.query.mockResolvedValueOnce([[]]);
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Ivan Petrov',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
      expect(judge.judge).toHaveBeenCalledTimes(1);
    });

    it('a name too short to key skips the scan entirely', async () => {
      const { svc, db } = keyFirst();
      db.query.mockResolvedValueOnce(candidate(0.99));
      await svc.resolveByName({
        db: db as any,
        name: 'C++',
        type: 'customer',
        incomingFacts: [],
      });
      expect(sqlOf(db, 0)).not.toContain('levenshtein');
    });

    it('a scan failure degrades to the embedding path rather than throwing', async () => {
      // A tenant migrated before 0148, or a SurrealDB without the
      // string-distance function: behave exactly as before this existed.
      const { svc, db } = keyFirst();
      db.query.mockRejectedValueOnce(new Error('no such function'));
      db.query.mockResolvedValueOnce(candidate(0.99));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Thomas Brandt',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:x');
    });
  });
});
