/**
 * fn::resolve_fact and a fact's end (0165), against a real SurrealDB.
 *
 * Pins the three decisions the migration makes and the one it must not
 * disturb:
 *  - two contradictory values that hold AT THE SAME TIME still park
 *    COMPETING (memory-fitness D6, the payout-cutoff pair) — also when
 *    one of them carries an end that the other's period overlaps;
 *  - a single_active slot only collides where the periods meet;
 *  - the end of a value the slot holds open ends that row (any
 *    semantics), and a different value's end leaves it alone.
 *
 * Vectors are fixed so the cosine gates are deterministic: every row of a
 * slot shares one vector (the slot-exact promotion floor is -1 anyway).
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

type Outcome = {
  outcome: string;
  factId: unknown;
  reason?: string;
  corroboratedFactId?: unknown;
  competingFactIds?: unknown[];
};

describe('fn::resolve_fact — fact valid time (0165)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_fact_valid_time_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const withDb = <T>(
    fn: (db: Parameters<Parameters<SurrealService['withCompany']>[1]>[0]) => Promise<T>,
  ) => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const resolve = (p: {
    entity: string;
    predicate: string;
    object: string;
    semantics: string;
    validFrom: string;
    validUntil?: string;
    recorder: string;
    evidence?: string;
    similarity?: number;
  }): Promise<Outcome> =>
    withDb(async (db) => {
      const [r] = await db.query<[Outcome]>(
        `RETURN fn::resolve_fact(
          type::record('knowledge_entity', $eid),
          $predicate, $object, NONE, [1.0, 0.0],
          0.7, type::datetime($vf), $vu, $source,
          0.5, $semantics, $similarity,
          0.30, 0.40, 0.20, 0.10,
          0.30, 0.15,
          NONE, NONE, NONE, NONE, NONE,
          NONE, 0.9
        )`,
        {
          eid: p.entity,
          predicate: p.predicate,
          object: p.object,
          vf: p.validFrom,
          vu: p.validUntil ? new Date(p.validUntil) : undefined,
          semantics: p.semantics,
          similarity: p.similarity ?? -1,
          source: {
            vertical: 'work',
            recorder: p.recorder,
            ...(p.evidence ? { evidence: [{ kind: 'document', ref: p.evidence }] } : {}),
          },
        },
      );
      return r;
    });

  const statusOf = (id: unknown) =>
    withDb(async (db) => {
      const [rows] = await db.query<[Array<{ status: string; validUntil?: unknown }>]>(
        `SELECT status, validUntil FROM $id`,
        { id },
      );
      const row = rows?.[0];
      return [row?.status, row?.validUntil ? new Date(String(row.validUntil)).toISOString() : null];
    });

  beforeAll(async () => {
    await withDb((db) =>
      db.query(
        `CREATE knowledge_entity:meridian SET type = 'customer', canonicalName = 'Meridian', canonicalNameLc = 'meridian';
         CREATE knowledge_entity:brain SET type = 'project', canonicalName = 'brain', canonicalNameLc = 'brain';
         CREATE knowledge_entity:sasha SET type = 'customer', canonicalName = 'Sasha', canonicalNameLc = 'sasha';`,
      ),
    );
  });

  it('two contradictory values holding at the same time still compete (D6)', async () => {
    const priya = await resolve({
      entity: 'meridian',
      predicate: 'payout_cutoff',
      object: '17:00 UTC',
      semantics: 'bitemporal',
      validFrom: '2026-03-10T10:35:00Z',
      recorder: 'priya',
    });
    expect(priya.outcome).toBe('INSERTED');
    const docs = await resolve({
      entity: 'meridian',
      predicate: 'payout_cutoff',
      object: '16:30 UTC',
      semantics: 'bitemporal',
      validFrom: '2026-03-25T14:35:00Z',
      recorder: 'docs',
      evidence: 'meridian-api-docs-v2.3',
    });
    expect(docs.outcome).toBe('COMPETING');
    expect((docs.competingFactIds ?? []).map(String)).toEqual([String(priya.factId)]);
    expect(await statusOf(priya.factId)).toEqual(['competing', null]);

    // A contradiction that states an END is still a contradiction while
    // its period overlaps the open value — not the end of it (a different
    // value), and not a separate history row either.
    const open = await resolve({
      entity: 'meridian',
      predicate: 'settlement_window',
      object: 'T+1',
      semantics: 'bitemporal',
      validFrom: '2026-03-10T10:35:00Z',
      recorder: 'priya',
    });
    expect(open.outcome).toBe('INSERTED');
    const ended = await resolve({
      entity: 'meridian',
      predicate: 'settlement_window',
      object: 'T+2',
      semantics: 'bitemporal',
      validFrom: '2026-03-20T00:00:00Z',
      validUntil: '2026-12-31T00:00:00Z',
      recorder: 'ops',
    });
    expect(ended.outcome).toBe('COMPETING');
    expect(await statusOf(open.factId)).toEqual(['competing', null]);
  });

  it('a single_active slot collides only where the periods meet', async () => {
    const six = await resolve({
      entity: 'brain',
      predicate: 'engine_model',
      object: 'gpt-6-luna',
      semantics: 'single_active',
      validFrom: '2026-09-24T00:00:00Z',
      recorder: 'r1',
    });
    expect(six.outcome).toBe('INSERTED');
    // Written after the current value, ending where it begins.
    const prior = await resolve({
      entity: 'brain',
      predicate: 'engine_model',
      object: 'gpt-5.6-luna',
      semantics: 'single_active',
      validFrom: '1970-01-01T00:00:00Z',
      validUntil: '2026-09-24T00:00:00Z',
      recorder: 'r1',
    });
    expect(prior.outcome).toBe('INSERTED');
    expect(await statusOf(six.factId)).toEqual(['active', null]);
    // An open value that does meet the current one still replaces it.
    const seven = await resolve({
      entity: 'brain',
      predicate: 'engine_model',
      object: 'gpt-7-luna',
      semantics: 'single_active',
      validFrom: '2026-10-01T00:00:00Z',
      recorder: 'r1',
    });
    expect(seven.outcome).toBe('SUPERSEDED');
    expect((await statusOf(six.factId))[0]).toBe('superseded');
    expect(await statusOf(prior.factId)).toEqual(['active', '2026-09-24T00:00:00.000Z']);
  });

  it('the end of a value held open ends that row; another value’s end does not', async () => {
    const ninja = await resolve({
      entity: 'sasha',
      predicate: 'owns',
      object: 'Kawasaki Ninja',
      semantics: 'append_only',
      validFrom: '2026-08-01T00:00:00Z',
      recorder: 'r1',
    });
    expect(ninja.outcome).toBe('INSERTED');
    const honda = await resolve({
      entity: 'sasha',
      predicate: 'owns',
      object: 'Honda',
      semantics: 'append_only',
      validFrom: '1970-01-01T00:00:00Z',
      validUntil: '2026-08-05T00:00:00Z',
      recorder: 'r1',
    });
    expect(honda.outcome).toBe('INSERTED');
    expect(await statusOf(ninja.factId)).toEqual(['active', null]);

    const sold = await resolve({
      entity: 'sasha',
      predicate: 'owns',
      object: 'Kawasaki',
      semantics: 'append_only',
      validFrom: '1970-01-01T00:00:00Z',
      validUntil: '2026-08-10T00:00:00Z',
      recorder: 'r1',
    });
    expect(sold.outcome).toBe('CORROBORATED');
    expect(sold.reason).toBe('ended');
    expect(String(sold.corroboratedFactId)).toBe(String(ninja.factId));
    expect(await statusOf(ninja.factId)).toEqual(['active', '2026-08-10T00:00:00.000Z']);
    expect((await statusOf(sold.factId))[0]).toBe('corroborating');
  });
});
