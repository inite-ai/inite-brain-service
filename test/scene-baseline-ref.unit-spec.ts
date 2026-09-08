/**
 * `baselineRef` (0106 FLEXIBLE) with TWO producers — the namespacing and
 * its migration-free reading rule.
 *
 * The bug this closes: the enrichment pass stamps an EXPECTATION snapshot
 * ({beliefs, stampedAt, baselineVersion}) and belief promotion stamped a
 * REVISION BACKPOINTER ({belief, revision, value, stampedAt}) into the
 * same column, each writing the whole object — so a promotion revision
 * destroyed the pre-scene world model that nothing else records.
 *
 * Round-tripped here: legacy-A (expectation), legacy-B (backpointer), the
 * namespaced shape, and the hybrid a nested SET would leave behind — plus
 * the coexistence path (write expectation → promote → BOTH readable).
 */
import { StringRecordId } from 'surrealdb';
import {
  mergeSupersededFrom,
  namespacedBaselineRef,
  readSceneBaselineRef,
  stampSupersededFrom,
  type BeliefSupersededRef,
} from '../src/admin/scene-baseline-ref';
import { baselineRefPayload } from '../src/admin/scene-prediction-baseline';

/** Legacy-A, produced by the REAL enricher payload builder (#473). */
const expectation = () =>
  baselineRefPayload([
    { id: 'semantic_belief:b1', subject: 'mika', field: 'home.city', value: 'lisbon', revision: 1 },
  ]);

/** Legacy-B, the exact object belief promotion used to write. */
const backpointer = (): BeliefSupersededRef => ({
  belief: 'semantic_belief:b1',
  revision: 1,
  value: 'lisbon',
  stampedAt: '2026-03-05T10:00:00.000Z',
});

describe('readSceneBaselineRef (tolerant of every stored shape)', () => {
  it('legacy-A: a bare expectation snapshot reads as the expectation section', () => {
    const sections = readSceneBaselineRef(expectation());
    expect(sections.supersededFrom).toBeNull();
    expect(sections.expectation).toMatchObject({
      baselineVersion: 'scene-baseline-v1',
      beliefs: [{ subject: 'mika', field: 'home.city', value: 'lisbon' }],
    });
    expect(sections.expectation!.stampedAt).toBeDefined();
  });

  it('legacy-B: a bare revision backpointer reads as the supersededFrom section', () => {
    const sections = readSceneBaselineRef(backpointer());
    expect(sections.expectation).toBeNull();
    expect(sections.supersededFrom).toEqual(backpointer());
  });

  it('namespaced: both sections read back independently', () => {
    const stored = namespacedBaselineRef({
      expectation: expectation(),
      supersededFrom: backpointer(),
    });
    const sections = readSceneBaselineRef(stored);
    expect(sections.expectation!.beliefs).toHaveLength(1);
    expect(sections.supersededFrom).toEqual(backpointer());
  });

  it('a namespaced row is never re-read as legacy (the keys win)', () => {
    // A namespaced object has neither a top-level `beliefs` array nor a
    // top-level `belief` string, so the legacy fill finds nothing — but
    // pin it, because an if/else reader would have got this wrong.
    const stored = namespacedBaselineRef({ expectation: expectation(), supersededFrom: null });
    expect(readSceneBaselineRef(stored).supersededFrom).toBeNull();
    expect(readSceneBaselineRef(stored).expectation!.beliefs).toHaveLength(1);
  });

  it('hybrid: legacy fields beside a namespaced key both read (what a nested SET leaves)', () => {
    const sections = readSceneBaselineRef({
      ...expectation(),
      supersededFrom: backpointer(),
    });
    expect(sections.expectation!.beliefs).toHaveLength(1);
    expect(sections.supersededFrom).toEqual(backpointer());
  });

  it.each([
    ['undefined (the never-written column)', undefined],
    ['null', null],
    ['a scalar', 'nonsense'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a half-written backpointer (no revision)', { belief: 'semantic_belief:b1' }],
    ['a backpointer with a non-string belief', { belief: 42, revision: 1 }],
    ['an expectation with a non-array beliefs', { beliefs: 'lots' }],
  ])('junk reads as two empty sections: %s', (_name, raw) => {
    expect(readSceneBaselineRef(raw)).toEqual({ expectation: null, supersededFrom: null });
  });

  it('degrades a half-written expectation instead of throwing', () => {
    const sections = readSceneBaselineRef({ beliefs: [], baselineVersion: 7 });
    expect(sections.expectation).toEqual({ beliefs: [] });
  });

  it('degrades a backpointer missing value/stampedAt to empty strings', () => {
    expect(
      readSceneBaselineRef({ belief: 'semantic_belief:b1', revision: 3 }).supersededFrom,
    ).toEqual({ belief: 'semantic_belief:b1', revision: 3, value: '', stampedAt: '' });
  });
});

describe('namespacedBaselineRef (what gets stored)', () => {
  it('omits absent sections rather than nulling them', () => {
    expect(namespacedBaselineRef({ expectation: null, supersededFrom: backpointer() })).toEqual({
      supersededFrom: backpointer(),
    });
    expect(namespacedBaselineRef({ expectation: null, supersededFrom: null })).toEqual({});
  });

  it('round-trips: store -> read -> store is a fixed point', () => {
    const first = namespacedBaselineRef({
      expectation: expectation(),
      supersededFrom: backpointer(),
    });
    const second = namespacedBaselineRef(readSceneBaselineRef(first));
    expect(second).toEqual(first);
  });
});

describe('mergeSupersededFrom (the promotion write)', () => {
  it('PRESERVES a legacy-A expectation while stamping the backpointer', () => {
    const merged = mergeSupersededFrom(expectation(), backpointer());
    const sections = readSceneBaselineRef(merged);
    expect(sections.expectation!.beliefs).toHaveLength(1);
    expect(sections.supersededFrom).toEqual(backpointer());
  });

  it('preserves an ALREADY-namespaced expectation', () => {
    const stored = namespacedBaselineRef({ expectation: expectation(), supersededFrom: null });
    expect(
      readSceneBaselineRef(mergeSupersededFrom(stored, backpointer())).expectation,
    ).not.toBeNull();
  });

  it('replaces an older backpointer (the newest revision is the baseline)', () => {
    const older: BeliefSupersededRef = { ...backpointer(), revision: 1, value: 'lisbon' };
    const newer: BeliefSupersededRef = { ...backpointer(), revision: 2, value: 'porto' };
    const merged = mergeSupersededFrom({ ...older }, newer);
    expect(readSceneBaselineRef(merged).supersededFrom).toEqual(newer);
  });

  it('an empty column yields a single-section object', () => {
    expect(mergeSupersededFrom(undefined, backpointer())).toEqual({
      supersededFrom: backpointer(),
    });
  });
});

describe('stampSupersededFrom (read-then-write, primary-key addressed)', () => {
  /** In-memory memory_episode rows keyed by record-id string. */
  class FakeSceneDb {
    rows = new Map<string, { baselineRef?: unknown }>();
    sql: string[] = [];

    query<T>(sqlText: string, params: Record<string, unknown> = {}): Promise<T> {
      this.sql.push(sqlText);
      if (sqlText.startsWith('SELECT id, baselineRef FROM memory_episode')) {
        const ids = (params.sceneIds as unknown[]).map(String);
        return Promise.resolve([
          ids
            .filter((id) => this.rows.has(id))
            .map((id) => ({ id, baselineRef: this.rows.get(id)!.baselineRef })),
        ] as T);
      }
      if (sqlText === 'UPDATE $scene SET baselineRef = $ref') {
        this.rows.set(String(params.scene), { baselineRef: params.ref });
        return Promise.resolve([] as T);
      }
      throw new Error(`FakeSceneDb: unhandled SQL: ${sqlText}`);
    }
  }

  it('BOTH writers coexist on one scene: enrich → promote → both readable', async () => {
    const db = new FakeSceneDb();
    // 1. the enrichment pass stamps its expectation snapshot (legacy-A).
    db.rows.set('memory_episode:s1', { baselineRef: expectation() });

    // 2. a promotion revision stamps its backpointer.
    const stamped = await stampSupersededFrom({
      db,
      sceneIds: ['memory_episode:s1'],
      ref: backpointer(),
    });
    expect(stamped).toBe(1);

    // 3. both are there.
    const sections = readSceneBaselineRef(db.rows.get('memory_episode:s1')!.baselineRef);
    expect(sections.expectation!.beliefs).toHaveLength(1);
    expect(sections.supersededFrom).toEqual(backpointer());
    // And the stored object is the NAMESPACED shape, not a hybrid.
    expect(Object.keys(db.rows.get('memory_episode:s1')!.baselineRef as object).sort()).toEqual([
      'expectation',
      'supersededFrom',
    ]);
  });

  it('a scene with NO prior baselineRef gets only the backpointer section', async () => {
    const db = new FakeSceneDb();
    db.rows.set('memory_episode:s1', {});
    await stampSupersededFrom({ db, sceneIds: ['memory_episode:s1'], ref: backpointer() });
    expect(db.rows.get('memory_episode:s1')!.baselineRef).toEqual({
      supersededFrom: backpointer(),
    });
  });

  it('re-stamping is idempotent for the same revision', async () => {
    const db = new FakeSceneDb();
    db.rows.set('memory_episode:s1', { baselineRef: expectation() });
    await stampSupersededFrom({ db, sceneIds: ['memory_episode:s1'], ref: backpointer() });
    const first = db.rows.get('memory_episode:s1')!.baselineRef;
    await stampSupersededFrom({ db, sceneIds: ['memory_episode:s1'], ref: backpointer() });
    expect(db.rows.get('memory_episode:s1')!.baselineRef).toEqual(first);
  });

  it('skips scenes that no longer exist, and writes nothing for an empty list', async () => {
    const db = new FakeSceneDb();
    db.rows.set('memory_episode:alive', {});
    const stamped = await stampSupersededFrom({
      db,
      sceneIds: ['memory_episode:gone', 'memory_episode:alive'],
      ref: backpointer(),
    });
    expect(stamped).toBe(1);
    expect(db.sql.filter((s) => s.startsWith('UPDATE'))).toHaveLength(1);

    const empty = new FakeSceneDb();
    expect(await stampSupersededFrom({ db: empty, sceneIds: [], ref: backpointer() })).toBe(0);
    expect(empty.sql).toEqual([]);
  });

  it('binds record ids, never raw strings (3.2.4 primary-key discipline)', async () => {
    const db = new FakeSceneDb();
    db.rows.set('memory_episode:s1', {});
    const seen: unknown[] = [];
    const spy = {
      query: <T>(sql: string, params: Record<string, unknown> = {}): Promise<T> => {
        seen.push(params.sceneIds ?? params.scene);
        return db.query<T>(sql, params);
      },
    };
    await stampSupersededFrom({ db: spy, sceneIds: ['memory_episode:s1'], ref: backpointer() });
    expect((seen[0] as unknown[])[0]).toBeInstanceOf(StringRecordId);
    expect(seen[1]).toBeInstanceOf(StringRecordId);
    // No WHERE over a secondary index anywhere in the write path.
    expect(db.sql.some((s) => s.startsWith('UPDATE memory_episode'))).toBe(false);
  });
});
