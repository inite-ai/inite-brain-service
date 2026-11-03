/**
 * EntityResolverService — inline entity resolution orchestration (unit).
 *
 * After the EntityJudge extraction, the resolver owns only the routing:
 * cosine candidate search (same type, above floor) → delegate the verdict
 * to the shared EntityJudgeService → reuse on "same", else create new.
 * The judge itself is mocked here and unit-tested separately.
 */
import { EntityCandidateService } from '../src/ingest/entity-candidates.service';
import { EntityResolverService } from '../src/ingest/entity-resolver.service';

type Cfg = Record<string, string>;

/**
 * The candidate scans, told apart by their SQL: the key, token-subset,
 * initials and shared-word scans run first and miss unless a test queues a
 * result, so every case still reaches the scan it was written to exercise.
 * Queue a result (or an Error) per scan; `ran(db)` lists the scans in the
 * order they ran.
 */
type Scan = 'key' | 'part' | 'initials' | 'word' | 'embedding' | 'identity';
const scanOf = (sql: string): Scan =>
  sql.includes('identity_of')
    ? 'identity'
    : sql.includes('levenshtein')
      ? 'key'
      : sql.includes('array::join')
        ? 'initials'
        : sql.includes('CONTAINS $word')
          ? 'word'
          : sql.includes('vector::similarity')
            ? 'embedding'
            : 'part';
const ran = (db: { query: jest.Mock }): Scan[] =>
  db.query.mock.calls.map((c) => scanOf(String(c[0])));
const sqlFor = (db: { query: jest.Mock }, scan: Scan, nth = 0): string =>
  String(db.query.mock.calls.filter((c) => scanOf(String(c[0])) === scan)[nth]![0]);
const paramsFor = (db: { query: jest.Mock }, scan: Scan, nth = 0): Record<string, unknown> =>
  db.query.mock.calls.filter((c) => scanOf(String(c[0])) === scan)[nth]![1];

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
  scans: Record<Scan, unknown[]>;
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
  const svc = new EntityResolverService(
    config,
    judge as any,
    new EntityCandidateService(config, embedder),
  );
  const scans: Record<Scan, unknown[]> = {
    key: [],
    part: [],
    initials: [],
    word: [],
    embedding: [],
    identity: [],
  };
  const db = {
    query: jest.fn((sql: string) => {
      const next = scans[scanOf(String(sql))].shift() ?? [[]];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  };
  return { svc, db, scans, judge };
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
    const { svc, db, scans, judge } = makeService(ENABLED);
    scans.embedding.push(candidate(0.7));
    expect(
      await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] }),
    ).toBeNull();
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it('asks every scan for the SAME type only — a different type is never a candidate', async () => {
    const { svc, db, scans } = makeService(ENABLED);
    scans.embedding.push(candidate(0.97));
    await svc.resolveByName({
      db: db as any,
      name: 'Acme Labs',
      type: 'customer',
      incomingFacts: [],
    });
    for (const call of db.query.mock.calls) {
      expect(String(call[0])).toContain('type = $type');
      expect(call[1]).toMatchObject({ type: 'customer' });
    }
  });

  it('reuses the existing entity when the judge says "same"', async () => {
    const { svc, db, scans, judge } = makeService(ENABLED);
    scans.embedding.push(candidate(0.95));
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
      const { svc, db, scans, judge } = makeService(ENABLED);
      scans.embedding.push(candidate(0.95));
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
  /**
   * The scan is over the ENTITIES' own name embeddings, not over
   * `name` facts. Measured on a live tenant on 2026-09-16: 33 entities,
   * 80 facts, zero with predicate `name` — nothing on the mention path
   * writes one, so the fact scan this replaced had always searched an
   * empty set. The KNN leg over the fact index went with it.
   */
  it('scans knowledge_entity.embedding, never a name fact', async () => {
    const { svc, db, scans } = makeService(ENABLED);
    scans.embedding.push(candidate(0.95));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    // A one-word name has no words to share, so no shared-word scan runs.
    expect(ran(db)).toEqual(['key', 'part', 'initials', 'embedding']);
    const sql = sqlFor(db, 'embedding');
    expect(sql).toContain('FROM knowledge_entity');
    expect(sql).toContain('vector::similarity::cosine(embedding, $q)');
    expect(sql).not.toContain('knowledge_fact');
    expect(sql).not.toContain("predicate = 'name'");
    expect(sql).not.toContain('<|'); // no KNN operator — entities are few
  });

  it('gates on width so a row from another space cannot raise for the whole query', async () => {
    const { svc, db, scans } = makeService(ENABLED);
    scans.embedding.push(candidate(0.95));
    await svc.resolveByName({ db: db as any, name: 'Acme', type: 'customer', incomingFacts: [] });
    expect(sqlFor(db, 'embedding')).toContain('array::len(embedding) = array::len($q)');
  });

  it('fences PRIVACY and merged-away entities on every scan', async () => {
    const { svc, db, scans } = makeService(ENABLED);
    scans.embedding.push(candidate(0.95));
    await svc.resolveByName({
      db: db as any,
      name: 'Acme Labs',
      type: 'customer',
      incomingFacts: [],
    });
    expect(ran(db)).toEqual(['key', 'part', 'initials', 'word', 'word', 'embedding']);
    // knowledge_entity.userId means "private to one user". The fact-scan
    // the embedding scan replaced fenced knowledge_fact.userId — the
    // SPEAKER — and on a per-user tenant excluded everything.
    for (const call of db.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toContain('FROM knowledge_entity');
      expect(sql).toContain('userId IS NONE');
      expect(sql).toContain('mergedInto IS NONE');
    }
  });

  describe('what the candidate scan is allowed to hide from the judge', () => {
    it('the DEFAULT floor lets a cross-script name pair reach the judge', async () => {
      // Measured on bge-m3: the same person written in two scripts scores
      // 0.695-0.865. The old 0.85 default admitted only the Latin/Cyrillic
      // end of that range, so Arabic, CJK and Devanagari spellings were
      // refused by a number before anything looked at their facts.
      const { svc, db, scans, judge } = makeService({ INGEST_INLINE_RESOLUTION_ENABLED: '1' });
      scans.embedding.push(candidate(0.695));
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
      const { svc, db, scans, judge } = makeService({ INGEST_INLINE_RESOLUTION_ENABLED: '1' });
      scans.embedding.push(candidate(0.48));
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
      const { svc, db, scans, judge } = makeService(
        { INGEST_INLINE_RESOLUTION_ENABLED: '1' },
        {
          judge: jest.fn().mockResolvedValue('different'),
        },
      );
      scans.embedding.push(candidate(0.712));
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
    const ENABLED_ONLY: Cfg = { INGEST_INLINE_RESOLUTION_ENABLED: '1' };

    it('runs FIRST and spends no other scan, nor an embedding, on a hit', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.key.push(neighbour(1, 'tomas brandt'));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Thomas Brandt',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:k');
      expect(ran(db)).toEqual(['key']);
      expect(sqlFor(db, 'key')).toContain('string::distance::levenshtein');
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

    it('keys the scan on the transliterated name', async () => {
      const { svc, db, scans } = makeService(ENABLED_ONLY);
      scans.embedding.push(candidate(0.99));
      await svc.resolveByName({
        db: db as any,
        name: 'Thomas Brandt',
        type: 'customer',
        incomingFacts: [],
      });
      expect(paramsFor(db, 'key')).toMatchObject({ key: 'thomas brandt' });
    });

    it('a far neighbour is dropped and the embedding scan still runs', async () => {
      // "ivan petrov" ~ "yfn bytrwf" is 0.64 normalised — far by edits and
      // close by meaning, which is the case the embedding still earns.
      const { svc, db, scans } = makeService(ENABLED_ONLY);
      scans.key.push(neighbour(7, 'yfn bytrwf'));
      scans.embedding.push(candidate(0.99));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Ivan Petrov',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:x'); // the EMBEDDING candidate, not the key one
    });

    it('a distance of ZERO is declined — the deterministic ladder owns that', async () => {
      // An exact key match was already tried in entity-upsert; reaching
      // here with one means it found TWO and refused to guess between them.
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.key.push(neighbour(0, 'thomas brandt'));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Thomas Brandt',
          type: 'customer',
          incomingFacts: [],
        }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
    });

    it('hands a near-miss to the judge, which refuses it', async () => {
      // "ivan petrov" ~ "ivan sidorov" is 0.33 — inside the ceiling on
      // purpose, because edits cannot tell it from "aarav sharma" ~
      // "arv srma" at the same distance. Facts can.
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      judge.judge.mockResolvedValue('different');
      scans.key.push(neighbour(4, 'ivan sidorov'));
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

    it('a name too short to key skips every key scan', async () => {
      const { svc, db, scans } = makeService(ENABLED_ONLY);
      scans.embedding.push(candidate(0.99));
      await svc.resolveByName({
        db: db as any,
        name: 'C++',
        type: 'customer',
        incomingFacts: [],
      });
      expect(ran(db)).toEqual(['embedding']);
    });

    it('a scan failure degrades to the next scan rather than throwing', async () => {
      // A tenant migrated before 0148, or a SurrealDB without the
      // string-distance function: behave exactly as before this existed.
      const { svc, db, scans } = makeService(ENABLED_ONLY);
      scans.key.push(new Error('no such function'));
      scans.embedding.push(candidate(0.99));
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

  /**
   * A name that is a PART of a longer name: "Артём" three turns after
   * "Артём Соколов" is eight edits away and nowhere near by meaning, so
   * neither scan above reaches it. A whole-token containment of the keys
   * names the candidate; the judge decides on facts; two such entities
   * are an ambiguity, not a guess.
   */
  describe('the token-subset scan', () => {
    const part = (rows: Array<{ id: string; keys: string[]; name?: string }>) => [
      rows.map((r) => ({ entityId: r.id, canonicalName: r.name, nameKeys: r.keys })),
    ];
    const ENABLED_ONLY: Cfg = { INGEST_INLINE_RESOLUTION_ENABLED: '1' };

    it('hands the first name to the judge with the full name as the candidate', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.part.push(
        part([{ id: 'knowledge_entity:full', keys: ['artem sokolov'], name: 'Артём Соколов' }]),
      );
      expect(
        await svc.resolveByName({ db: db as any, name: 'Артём', type: 'staff', incomingFacts: [] }),
      ).toBe('knowledge_entity:full');
      expect(ran(db)).toEqual(['key', 'part']); // no embedding spent
      expect(sqlFor(db, 'part')).toContain('string::starts_with');
      expect(paramsFor(db, 'part')).toMatchObject({ key: 'artem', pre: 'artem ' });
      expect(judge.judge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ names: { a: 'Артём Соколов', b: 'Артём' } }),
      );
    });

    it('the reverse direction: a full name arriving after the first name', async () => {
      const { svc, db, scans } = makeService(ENABLED_ONLY);
      scans.part.push(part([{ id: 'knowledge_entity:first', keys: ['artem'] }]));
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Артём Соколов',
          type: 'staff',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:first');
    });

    it('two entities sharing the token are an ambiguity — no candidate, embedding runs', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.part.push(
        part([
          { id: 'knowledge_entity:a', keys: ['artem sokolov'] },
          { id: 'knowledge_entity:b', keys: ['artem ivanov'] },
        ]),
      );
      expect(
        await svc.resolveByName({ db: db as any, name: 'Артём', type: 'staff', incomingFacts: [] }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
      expect(ran(db)).toContain('embedding');
    });

    it('a key that merely shares a prefix is not a part', async () => {
      // "artem" inside "artemis" is a substring, not a token.
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.part.push(part([{ id: 'knowledge_entity:x', keys: ['artemis'] }]));
      expect(
        await svc.resolveByName({ db: db as any, name: 'Артём', type: 'staff', incomingFacts: [] }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
    });
  });

  /**
   * An acronym and its expansion share nothing an edit distance or an
   * embedding of three letters can see; the initials of the longer key
   * are the blocking key (eval:entity-resolution: "IBM" was unreachable).
   */
  describe('the initials scan', () => {
    const ENABLED_ONLY: Cfg = { INGEST_INLINE_RESOLUTION_ENABLED: '1' };
    const hit = (rows: Array<{ id: string; name: string }>) => [
      rows.map((r) => ({ entityId: r.id, canonicalName: r.name })),
    ];

    it('hands the expansion to the judge for an acronym', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.initials.push(
        hit([{ id: 'knowledge_entity:ibm', name: 'International Business Machines' }]),
      );
      expect(
        await svc.resolveByName({ db: db as any, name: 'IBM', type: 'org', incomingFacts: [] }),
      ).toBe('knowledge_entity:ibm');
      expect(paramsFor(db, 'initials')).toMatchObject({ key: 'ibm', initials: '' });
      expect(judge.judge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ similarity: 'initials' }),
      );
    });

    it('asks for the acronym the expansion spells, the other way round', async () => {
      const { svc, db } = makeService(ENABLED_ONLY);
      await svc.resolveByName({
        db: db as any,
        name: 'International Business Machines',
        type: 'org',
        incomingFacts: [],
      });
      expect(paramsFor(db, 'initials')).toMatchObject({ initials: 'ibm' });
    });

    it('two entities with those initials are an ambiguity — no candidate', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.initials.push(
        hit([
          { id: 'knowledge_entity:a', name: 'International Business Machines' },
          { id: 'knowledge_entity:b', name: 'Integrated Bio Materials' },
        ]),
      );
      expect(
        await svc.resolveByName({ db: db as any, name: 'IBM', type: 'org', incomingFacts: [] }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
    });
  });

  /**
   * A word of the name only one known entity carries — the surname, as a
   * rule. A nickname or a sound-rendered given name ("Bob" / "Robert",
   * "Жуан" / "João") sits past every edit ceiling while the surname is
   * identical; the judge decides on facts.
   */
  describe('the shared-word scan', () => {
    const ENABLED_ONLY: Cfg = { INGEST_INLINE_RESOLUTION_ENABLED: '1' };
    const hit = (rows: Array<{ id: string; name: string }>) => [
      rows.map((r) => ({ entityId: r.id, canonicalName: r.name })),
    ];

    it('asks once per word and hands a unique carrier to the judge', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.word.push([[]]); // "bob": nobody
      scans.word.push(hit([{ id: 'knowledge_entity:rk', name: 'Robert King' }])); // "king"
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Bob King',
          type: 'person',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:rk');
      expect(paramsFor(db, 'word', 0)).toMatchObject({ word: 'bob' });
      expect(paramsFor(db, 'word', 1)).toMatchObject({ word: 'king' });
      expect(judge.judge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          similarity: 'shared-word',
          names: { a: 'Robert King', b: 'Bob King' },
        }),
      );
      expect(ran(db)).not.toContain('embedding');
    });

    it('a word several entities carry names a crowd, not a candidate', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.word.push(
        hit([
          { id: 'knowledge_entity:a', name: 'Northwind Bank' },
          { id: 'knowledge_entity:b', name: 'Banco Bank' },
        ]),
      );
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Bank Acme',
          type: 'org',
          incomingFacts: [],
        }),
      ).toBeNull();
      expect(judge.judge).not.toHaveBeenCalled();
    });

    it('two carriers already linked as one identity are one candidate', async () => {
      // The nightly dedup links "Alexander Volkov" and "Александр Волков";
      // the surname they share then names one identity, not a crowd.
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.word.push([[]]); // "sasha"
      scans.word.push(
        hit([
          { id: 'knowledge_entity:av', name: 'Alexander Volkov' },
          { id: 'knowledge_entity:av2', name: 'Александр Волков' },
        ]),
      );
      scans.identity.push([[{ id: 'knowledge_edge:1' }]]);
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Sasha Volkov',
          type: 'person',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:av');
      expect(judge.judge).toHaveBeenCalledTimes(1);
    });

    it('a word too short to be a key never blocks ("o Banco Inter")', async () => {
      const { svc, db } = makeService(ENABLED_ONLY);
      await svc.resolveByName({
        db: db as any,
        name: 'o Banco Inter',
        type: 'org',
        incomingFacts: [],
      });
      const words = db.query.mock.calls
        .filter((c) => scanOf(String(c[0])) === 'word')
        .map((c) => (c[1] as { word: string }).word);
      expect(words).toEqual(['banco', 'inter']);
    });

    it('a refusal on the nearest spelling moves on to the next scan', async () => {
      // "Ivan Sidorov" is near "Ivan Petrov" by edits; the judge refuses,
      // and the entity the surname names is still asked about.
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      scans.key.push([[{ entityId: 'knowledge_entity:petrov', dist: 4, matched: 'ivan petrov' }]]);
      scans.word.push([[]]); // "ivan": the refused one is skipped below anyway
      scans.word.push(hit([{ id: 'knowledge_entity:sidorov', name: 'Иван Сидоров' }]));
      judge.judge.mockResolvedValueOnce('different').mockResolvedValueOnce('same');
      expect(
        await svc.resolveByName({
          db: db as any,
          name: 'Ivan Sidorov',
          type: 'person',
          incomingFacts: [],
        }),
      ).toBe('knowledge_entity:sidorov');
      expect(judge.judge).toHaveBeenCalledTimes(2);
    });

    it('a candidate two scans propose is judged once', async () => {
      const { svc, db, scans, judge } = makeService(ENABLED_ONLY);
      judge.judge.mockResolvedValue('different');
      scans.key.push([[{ entityId: 'knowledge_entity:k', dist: 3, matched: 'robert king' }]]);
      scans.word.push([[]]);
      scans.word.push(hit([{ id: 'knowledge_entity:k', name: 'Robert King' }]));
      await svc.resolveByName({
        db: db as any,
        name: 'Bob King',
        type: 'person',
        incomingFacts: [],
      });
      expect(judge.judge).toHaveBeenCalledTimes(1);
    });
  });
});
