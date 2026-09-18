/**
 * The extractor's supersession on the write path:
 *  - FactResolverService closes the rows a fact names in `supersedes`
 *    with the fn's own supersede shape, after the fn ran; the winner and
 *    an absent list are left alone; the result is folded to SUPERSEDED
 *    with the closed ids; a failing close warns and keeps the insert;
 *  - factTiming: the extractor's day takes validFrom when it is at or
 *    before the turn, a scheduled day leaves validFrom at the turn, and
 *    both stamp objectMeta.date; no day ⇒ the chrono fallback;
 *  - candidate-merge carries known / eventTime / supersedes across
 *    contributors (supersedes as a union, eventTime from the leader);
 *  - the upsert ladder files a pinned mention under the known entity,
 *    follows a merged row, and falls through on a stale id.
 */
import { FactResolverService } from '../src/ingest/fact-resolver.service';
import { factTiming } from '../src/ingest/event-time';
import { mergeCandidates } from '../src/documents/candidate-merge';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';

describe('FactResolverService — explicit supersession', () => {
  function make(opts: { closeFails?: boolean; closed?: string[] } = {}) {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
        queries.push({ sql, params });
        if (sql.includes("status = 'superseded'")) {
          if (opts.closeFails) throw new Error('close failed');
          return [null, null, null, (opts.closed ?? []).map((id) => ({ id }))];
        }
        return [{ factId: 'knowledge_fact:new', outcome: 'INSERTED' }];
      }),
    };
    const factEmbedding = { embed: jest.fn(async () => [0.1]), writeAltEmbeddingIfHype: jest.fn() };
    const registry = {
      getSnapshot: jest.fn(async () => ({})),
      policyFor: jest.fn(() => ({ semantics: 'append_only' })),
    };
    const svc = new FactResolverService(factEmbedding as never, registry as never);
    return { svc, db, queries };
  }
  const input = (supersedes?: string[]) => ({
    companyId: 'co',
    entityId: 'knowledge_entity:e1',
    predicate: 'monthly_budget',
    object: '2500',
    confidence: 0.9,
    validFrom: new Date('2026-09-16T11:00:00Z'),
    source: {},
    precomputedEmbedding: [0.1],
    supersedes,
  });

  it('closes the named rows after the fn, excluding the winner, and folds the outcome', async () => {
    const { svc, db, queries } = make({ closed: ['knowledge_fact:old'] });
    const { result } = await svc.resolve(
      db as never,
      input(['knowledge_fact:old', 'knowledge_fact:new']),
    );
    const close = queries.find((q) => q.sql.includes("status = 'superseded'"))!;
    expect(close).toBeDefined();
    expect(String(close.params.winner)).toBe('knowledge_fact:new');
    expect((close.params.ids as unknown[]).map(String)).toEqual(['knowledge_fact:old']);
    expect(close.params.valid_from).toEqual(new Date('2026-09-16T11:00:00Z'));
    // The fn's shape, with the inverted-interval guard.
    expect(close.sql).toContain("retractionReason = 'superseded'");
    expect(close.sql).toContain('supersededBy = $winner');
    expect(close.sql).toContain(
      'IF $valid_from > $loser.validFrom THEN $valid_from ELSE $loser.validFrom END',
    );
    expect(result.outcome).toBe('SUPERSEDED');
    expect(result.supersededFactIds).toEqual(['knowledge_fact:old']);
  });

  it('runs nothing without a list, or when the list holds only the winner', async () => {
    const { svc, db, queries } = make();
    await svc.resolve(db as never, input());
    await svc.resolve(db as never, input(['knowledge_fact:new']));
    expect(queries.some((q) => q.sql.includes("status = 'superseded'"))).toBe(false);
  });

  it('keeps the insert and the fn verdict when the close fails or closes nothing', async () => {
    const failing = make({ closeFails: true });
    const a = await failing.svc.resolve(failing.db as never, input(['knowledge_fact:old']));
    expect(a.result.outcome).toBe('INSERTED');
    const nothing = make({ closed: [] });
    const b = await nothing.svc.resolve(nothing.db as never, input(['knowledge_fact:gone']));
    expect(b.result.outcome).toBe('INSERTED');
    expect(b.result.supersededFactIds).toBeUndefined();
  });
});

describe('factTiming', () => {
  const said = '2026-09-16T11:00:00Z';
  const opts = { on: false };

  it('an occurred day becomes validFrom; a scheduled day leaves validFrom at the turn', () => {
    const past = factTiming({ predicate: 'signed_on', eventTime: '2026-09-12' }, said, opts);
    expect(past.validFrom.toISOString()).toBe('2026-09-12T00:00:00.000Z');
    expect(past.objectMeta).toEqual({ date: '2026-09-12' });
    const future = factTiming({ predicate: 'deadline', eventTime: '2026-09-30' }, said, opts);
    expect(future.validFrom.toISOString()).toBe('2026-09-16T11:00:00.000Z');
    expect(future.objectMeta).toEqual({ date: '2026-09-30' });
  });

  it('without a day, or with a malformed one, the turn time (chrono lane off) and no objectMeta', () => {
    expect(factTiming({ predicate: 'x' }, said, opts)).toEqual({
      validFrom: new Date(said),
    });
    expect(factTiming({ predicate: 'x', eventTime: 'soon' }, said, opts)).toEqual({
      validFrom: new Date(said),
    });
  });
});

describe('mergeCandidates carries the memory-context fields', () => {
  const row = (
    id: string,
    kind: 'entity' | 'fact',
    payload: Record<string, unknown>,
    confidence = 0.9,
  ) => ({ id, runId: 'run', chunkSeq: 0, kind, confidence, status: 'pending', payload }) as never;

  it('known on the entity; supersedes as a union and eventTime from the leader on the fact', () => {
    const merged = mergeCandidates([
      row('c1', 'entity', {
        entityIndex: 0,
        name: 'Rui',
        type: 'customer',
        known: 'knowledge_entity:rui',
      }),
      row('c2', 'fact', {
        entityIndex: 0,
        predicate: 'budget',
        object: '2500',
        eventTime: '2026-09-16',
        supersedes: ['knowledge_fact:a'],
      }),
      row(
        'c3',
        'fact',
        {
          entityIndex: 0,
          predicate: 'budget',
          object: '2500',
          eventTime: '2026-09-17',
          supersedes: ['knowledge_fact:b', 'knowledge_fact:a'],
        },
        0.95,
      ),
    ]);
    expect(merged.entities[0]).toMatchObject({ name: 'Rui', known: 'knowledge_entity:rui' });
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]).toMatchObject({
      predicate: 'budget',
      eventTime: '2026-09-17',
      supersedes: ['knowledge_fact:a', 'knowledge_fact:b'],
    });
  });

  it('absent fields stay absent', () => {
    const merged = mergeCandidates([
      row('c1', 'entity', { entityIndex: 0, name: 'Rui', type: 'customer' }),
      row('c2', 'fact', { entityIndex: 0, predicate: 'budget', object: '2500' }),
    ]);
    expect(merged.entities[0]).not.toHaveProperty('known');
    expect(merged.facts[0]?.eventTime).toBeUndefined();
    expect(merged.facts[0]?.supersedes).toBeUndefined();
  });
});

describe('EntityUpsertService — a pinned mention', () => {
  function make(rows: Record<string, { id: string; mergedInto?: string }>) {
    const queries: string[] = [];
    const db = {
      query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
        queries.push(sql);
        if (sql.includes('SELECT id, mergedInto FROM $id')) {
          const row = rows[String(params?.id)];
          return [row ? [row] : []];
        }
        if (sql.startsWith('SELECT id FROM knowledge_entity')) return [[]];
        if (sql.includes('CREATE')) return [[{ id: 'knowledge_entity:created' }]];
        return [[]];
      }),
      create: jest.fn(async () => [{ id: 'knowledge_entity:created' }]),
    };
    const svc = new EntityUpsertService();
    return { svc, db, queries };
  }
  const call = (svc: EntityUpsertService, db: unknown, known: string) =>
    svc.resolveOrCreateNamedEntity({
      db: db as never,
      e: { name: 'Rui', type: 'customer', known },
      hint: undefined,
      _contextRef: { vertical: 'chat' },
    });

  it('files the mention under the pinned entity and stamps the surface form as an alias', async () => {
    const { svc, db, queries } = make({ 'knowledge_entity:rui': { id: 'knowledge_entity:rui' } });
    expect(await call(svc, db, 'knowledge_entity:rui')).toBe('knowledge_entity:rui');
    expect(queries.some((q) => q.includes('aliases = array::union'))).toBe(true);
    expect(queries.some((q) => q.startsWith('SELECT id FROM knowledge_entity'))).toBe(false);
  });

  it('follows a merged row to its survivor', async () => {
    const { svc, db } = make({
      'knowledge_entity:old': { id: 'knowledge_entity:old', mergedInto: 'knowledge_entity:new' },
    });
    expect(await call(svc, db, 'knowledge_entity:old')).toBe('knowledge_entity:new');
  });

  it('a stale pin falls through to the ladder', async () => {
    const { svc, db, queries } = make({});
    await call(svc, db, 'knowledge_entity:gone');
    expect(queries.some((q) => q.startsWith('SELECT id FROM knowledge_entity'))).toBe(true);
  });
});
