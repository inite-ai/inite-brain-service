/**
 * The nightly dreams passes that judge FACTS sweep every memory slice —
 * the tenant's, and each user's — and never pair two slices.
 *
 * On production every fact a user-bound key writes is personal, and the
 * competing-fact resolver and the corroboration sweep read `userId IS
 * NONE` only: they never saw a pair or a group there. This pins, against
 * a real SurrealDB:
 *  - corroboration groups carry their slice; a user's re-worded
 *    duplicates form a group, and its members are that user's facts only;
 *  - the resolver pairs a user's two competing facts, and never pairs a
 *    tenant-global fact with a personal one or two users' facts.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { StringRecordId } from 'surrealdb';
import { DreamsCorroborateService } from '../src/dreams/corroborate.service';
import { DreamsResolverService } from '../src/dreams/resolver.service';

type Group = { entityId: unknown; predicate: string; scope: string; n: number };
type Member = { id: unknown; object: string };

describe('dreams sweep every memory slice (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_dreams_scope_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (p: { id: string; predicate: string; object: string; userId?: string }) => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: p.id },
        predicate: p.predicate,
        object: p.object,
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: `bot_${p.object.length}` },
        ...(p.userId ? { userId: p.userId } : {}),
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  const withDb = <T>(fn: (db: never) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, (db) => fn(db as never));

  it("corroboration finds a user's group and reads only that user's members", async () => {
    await ingest({ id: 'scope_a', predicate: 'claim_probe', object: 'gold tier', userId: 'u1' });
    await ingest({
      id: 'scope_a',
      predicate: 'claim_probe',
      object: 'on the gold tier',
      userId: 'u1',
    });
    await ingest({ id: 'scope_a', predicate: 'claim_probe', object: 'silver', userId: 'u2' });

    const svc = f.app.get(DreamsCorroborateService) as unknown as {
      findCandidateGroups: (db: unknown, v: null) => Promise<{ groups: Group[] }>;
      fetchGroupMembers: (db: unknown, g: Group, v: null) => Promise<Member[]>;
    };
    await withDb(async (db) => {
      // Both variants active: the write-time resolver may already have
      // closed one — the sweep is what collapses the ones it did not.
      await (db as unknown as { query: (s: string) => Promise<unknown> }).query(
        `UPDATE knowledge_fact SET status = 'active', supersededBy = NONE, validUntil = NONE
           WHERE predicate = 'claim_probe'`,
      );
      const { groups } = await svc.findCandidateGroups(db, null);
      const mine = groups.filter((g) => g.predicate === 'claim_probe');
      expect(mine.map((g) => g.scope)).toEqual(['u1']);
      const members = await svc.fetchGroupMembers(db, mine[0]!, null);
      expect(members.map((m) => m.object).sort()).toEqual(['gold tier', 'on the gold tier']);
    });
  });

  it("the resolver pairs a user's competing facts, never across slices", async () => {
    const own = [
      await ingest({ id: 'scope_b', predicate: 'plan_probe', object: 'basic', userId: 'u1' }),
      await ingest({ id: 'scope_b', predicate: 'plan_probe', object: 'premium', userId: 'u1' }),
    ];
    const mixed = [
      await ingest({ id: 'scope_c', predicate: 'plan_probe', object: 'basic' }),
      await ingest({ id: 'scope_c', predicate: 'plan_probe', object: 'premium', userId: 'u2' }),
    ];
    const ids = [...own, ...mixed].map((id) => new StringRecordId(id));
    await withDb(async (db) => {
      // Parked as COMPETING and settled past the resolver's age gate.
      await (db as unknown as { query: (s: string, v: object) => Promise<unknown> }).query(
        `UPDATE knowledge_fact SET status = 'competing', recordedAt = time::now() - 30d
           WHERE id INSIDE $ids`,
        { ids },
      );
      const svc = f.app.get(DreamsResolverService) as unknown as {
        findCompetingPairs: (
          db: unknown,
          v: null,
        ) => Promise<Array<{ a: { id: unknown }; b: { id: unknown } }>>;
      };
      const pairs = await svc.findCompetingPairs(db, null);
      const paired = pairs.map((p) => [String(p.a.id), String(p.b.id)].sort().join('|'));
      expect(paired).toContain([...own].sort().join('|'));
      expect(paired.some((p) => mixed.some((id) => p.includes(id)))).toBe(false);
    });
  });
});
