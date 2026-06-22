/**
 * Concurrency invariant for single_active predicates: no matter how many
 * ingests of the same (entity, predicate) race, at most ONE row may end up
 * status='active'. fn::resolve_fact is a SELECT-then-write inside a single
 * statement, wrapped in retryOnUniqueViolation.
 *
 * This is the regression guard for the "concurrent ingest leaves two active"
 * concern. There is no partial-unique index (SurrealDB has none), and this
 * test demonstrates none is needed: SurrealDB's optimistic-concurrency
 * control invalidates the read-set of a racing resolve, so the loser aborts
 * with a read conflict and retryOnUniqueViolation re-runs it — on the retry
 * it sees the winner's committed active row and supersedes instead of adding
 * a second active. At fan-out == pool size every request converges cleanly.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('concurrent single_active ingest stays single-active', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('leaves at most one active row after a concurrent fan-out', async () => {
    const entity = { vertical: 'rent', id: 'concurrent_tier_customer' };
    // Fan-out up to the connection pool (default 8) so requests genuinely
    // overlap on distinct pooled connections.
    const N = 8;

    const reqs = Array.from({ length: N }, (_, i) =>
      f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: entity,
          predicate: 'tier',
          object: `tier_${i}`,
          validFrom: '2026-01-01',
          source: { vertical: 'rent', eventId: `evt_${i}` },
          confidence: 0.9,
        }),
    );
    const results = await Promise.allSettled(reqs);
    const ok = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 201,
    ).length;
    // At fan-out == pool size every concurrent resolve converges via the
    // OCC-retry loop, so all should land cleanly (no retry-exhaustion 500s).
    expect(ok).toBe(N);

    const surreal = f.app.get(SurrealService);
    const activeCount = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ c: number }>]>(
        `SELECT count() AS c FROM knowledge_fact
           WHERE predicate = 'tier' AND status = 'active'
           GROUP ALL`,
      );
      return (rows as Array<{ c: number }>)?.[0]?.c ?? 0;
    });

    // THE invariant. Pre-fix, a lost SELECT-then-write race could leave >1.
    expect(activeCount).toBeLessThanOrEqual(1);
  });
});
