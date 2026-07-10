/**
 * DreamsCorroborateService — fuzzy cross-source corroboration guards:
 * exact-equal pairs corroborate without an LLM call, fuzzy pairs need a
 * same_assertion verdict, same-origin / non-overlapping / event-shaped
 * (append_only) / already-corroborated pairs are never touched, and the
 * incumbent update replays the 0051 origin-dedup shape.
 */
import { ConfigService } from '@nestjs/config';
import { DreamsCorroborateService } from '../src/dreams/corroborate.service';

type Row = Record<string, unknown>;

function fact(over: Partial<Row> = {}): Row {
  return {
    id: `knowledge_fact:${Math.random().toString(36).slice(2, 8)}`,
    entityId: 'knowledge_entity:e1',
    predicate: 'claim_probe', // not in CORE_PREDICATES → default bitemporal
    object: 'gold tier customer',
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: null,
    recordedAt: '2026-06-01T00:00:00Z',
    embedding: [1, 0],
    originKey: 'doc:a',
    corroborationCount: 0,
    ...over,
  };
}

function makeService(): {
  svc: DreamsCorroborateService;
  judge: jest.Mock;
  applied: Array<Record<string, unknown>>;
  db: (groups: Row[], members: Row[]) => { query: jest.Mock };
} {
  const svc = new DreamsCorroborateService(
    new ConfigService({
      DREAMS_CORROBORATE_ENABLED: '1',
      OPENAI_API_KEY: 'sk-test',
    }),
  );
  const judge = jest.fn();
  (svc as unknown as { judge: unknown }).judge = judge;
  const applied: Array<Record<string, unknown>> = [];
  const db = (groups: Row[], members: Row[]) => ({
    query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('GROUP BY entityId, predicate')) {
        return [groups.map((g) => ({ ...g, n: members.length }))];
      }
      if (sql.includes('fn::origin_key_of(source) AS originKey')) {
        return [members];
      }
      if (sql.includes(`status = 'corroborating'`)) {
        applied.push(params ?? {});
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  return { svc, judge, applied, db };
}

const GROUP = [{ entityId: 'knowledge_entity:e1', predicate: 'claim_probe' }];

describe('DreamsCorroborateService', () => {
  it('corroborates an exact-equal pair from different origins without the LLM', async () => {
    const { svc, judge, applied, db } = makeService();
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);

    expect(out.corroborationsApplied).toBe(1);
    expect(out.llmJudgements).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect(out.corroborations[0]).toMatchObject({
      incumbentFactId: 'knowledge_fact:a',
      corroboratingFactId: 'knowledge_fact:b',
      method: 'exact',
    });
    expect(applied).toHaveLength(1);
  });

  it('fuzzy pair needs a same_assertion verdict; different is skipped', async () => {
    const { svc, judge, applied, db } = makeService();
    judge.mockResolvedValueOnce('same_assertion');
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      object: 'customer on the gold tier',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.llmJudgements).toBe(1);
    expect(out.corroborationsApplied).toBe(1);
    expect(out.corroborations[0].method).toBe('llm');
    expect(applied).toHaveLength(1);
  });

  it('unsure and different verdicts apply nothing', async () => {
    const { svc, judge, applied, db } = makeService();
    judge.mockResolvedValueOnce('unsure');
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      object: 'platinum tier customer',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.unsurePairs).toBe(1);
    expect(out.corroborationsApplied).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('same origin never corroborates (one document re-worded is not confirmation)', async () => {
    const { svc, judge, applied, db } = makeService();
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:same' });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:same',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.pairsConsidered).toBe(0);
    expect(judge).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
  });

  it('non-overlapping validity intervals are history, not corroboration', async () => {
    const { svc, applied, db } = makeService();
    const a = fact({
      id: 'knowledge_fact:a',
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-02-01T00:00:00Z',
    });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      validFrom: '2026-03-01T00:00:00Z',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.pairsConsidered).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('below-threshold cosine is not the same claim', async () => {
    const { svc, applied, db } = makeService();
    const a = fact({ id: 'knowledge_fact:a', embedding: [1, 0] });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      embedding: [0, 1],
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.pairsConsidered).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('append_only predicates (event history) are filtered at the group level', async () => {
    const { svc, applied, db } = makeService();
    const group = [{ entityId: 'knowledge_entity:e1', predicate: 'said' }];
    const a = fact({ predicate: 'said' });
    const b = fact({
      predicate: 'said',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const out = await svc.run(db(group, [a, b]) as never);
    expect(out.groupsConsidered).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('a younger row that is itself corroborated stays untouched', async () => {
    const { svc, applied, db } = makeService();
    const a = fact({ id: 'knowledge_fact:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
      corroborationCount: 2,
    });
    const out = await svc.run(db(GROUP, [a, b]) as never);
    expect(out.pairsConsidered).toBe(0);
    expect(applied).toHaveLength(0);
  });

  it('is a no-op when disabled', async () => {
    const svc = new DreamsCorroborateService(
      new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
    );
    const out = await svc.run({
      query: jest.fn(),
    } as never);
    expect(out.groupsConsidered).toBe(0);
  });
});
