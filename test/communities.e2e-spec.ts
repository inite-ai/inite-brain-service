/**
 * Communities — end-to-end smoke.
 *
 * Seeds two disjoint triangles of linked entities, runs the dreams
 * `communities` op, and asserts:
 *   - two communities materialise, each with 3 members + a summary,
 *   - search / list / find-for-entity read surfaces resolve them,
 *   - a second build with no graph change REUSES every community via the
 *     watermark (graphiti summarize_saga port) — zero rebuilds.
 *
 * Embeddings are stubbed by the fixture, so the summary embedding +
 * cosine search are deterministic and need no live model.
 */
process.env.DREAMS_COMMUNITIES_ENABLED = '1';
process.env.COMMUNITIES_MIN_SIZE = '3';

import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { DreamsService } from '../src/dreams/dreams.service';
import { CommunityService } from '../src/communities/community.service';

describe('Communities — build + read surfaces', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let entityA = '';

  const ingestName = async (id: string, name: string) => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id },
        predicate: 'name',
        object: name,
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.95,
        source: { vertical: 'rent' },
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  const link = async (a: string, b: string) => {
    const res = await f.http
      .post('/v1/ingest/link')
      .set(auth())
      .send({
        from: { vertical: 'rent', id: a },
        to: { vertical: 'rent', id: b },
        kind: 'related_to',
        source: { vertical: 'rent' },
      });
    expect([200, 201]).toContain(res.status);
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_communities_e2e' });

    // Cluster 1 — billing topic triangle.
    const factA = await ingestName('comm_a', 'Acme Invoicing');
    await ingestName('comm_b', 'Acme Billing Run');
    await ingestName('comm_c', 'Acme Dunning');
    await link('comm_a', 'comm_b');
    await link('comm_b', 'comm_c');
    await link('comm_a', 'comm_c');

    // Cluster 2 — logistics topic triangle.
    await ingestName('comm_x', 'Warehouse North');
    await ingestName('comm_y', 'Warehouse South');
    await ingestName('comm_z', 'Fleet Dispatch');
    await link('comm_x', 'comm_y');
    await link('comm_y', 'comm_z');
    await link('comm_x', 'comm_z');

    const surreal = f.app.get(SurrealService);
    entityA = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: factA.split(':')[1] },
      );
      return String((rows as any[])?.[0]?.entityId ?? '');
    });
    expect(entityA).toMatch(/^knowledge_entity:/);

    // Build communities through the dreams leg.
    const stats = await f.app
      .get(DreamsService)
      .runForTenant(f.companyId, ['communities']);
    expect(stats.communities?.communitiesBuilt).toBe(2);
    expect(stats.communities?.entitiesClustered).toBe(6);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('materialises two communities of three members each', async () => {
    const list = await f.app.get(CommunityService).list(f.companyId, {});
    expect(list).toHaveLength(2);
    for (const c of list) {
      expect(c.memberCount).toBe(3);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it('find_entity_communities resolves an entity to its cluster', async () => {
    const out = await f.app.get(CommunityService).forEntity(f.companyId, entityA);
    expect(out).toHaveLength(1);
    expect(out[0].memberCount).toBe(3);
  });

  it('search returns a community for a topical query', async () => {
    const out = await f.app
      .get(CommunityService)
      .search(f.companyId, { query: 'Acme billing', minSimilarity: 0 });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].similarity).toBeGreaterThanOrEqual(0);
  });

  it('rebuild with no graph change reuses every community (watermark)', async () => {
    const stats = await f.app
      .get(DreamsService)
      .runForTenant(f.companyId, ['communities']);
    expect(stats.communities?.communitiesBuilt).toBe(0);
    expect(stats.communities?.communitiesReused).toBe(2);
    expect(stats.communities?.communitiesRemoved).toBe(0);
    // Still exactly two communities — no duplication on re-run.
    const list = await f.app.get(CommunityService).list(f.companyId, {});
    expect(list).toHaveLength(2);
  });
});
