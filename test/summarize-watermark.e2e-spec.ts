/**
 * summarize_entity watermark invalidation — end-to-end.
 *
 * Pins the graphiti-borrowed dual-watermark behaviour the prior LRU-only
 * cache could not deliver:
 *
 *   - A repeated call with no new facts is served from cache.
 *   - A BACKFILLED fact (validFrom in the PAST, recordedAt = now) lands a
 *     newer wall-clock watermark, so the next "now" call is rebuilt
 *     (cached: false) even though the new fact is historical. This is the
 *     exact case an asOf-keyed cache misses.
 *   - The result exposes `asOfValid` (event-time the summary reflects).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SummarizeEntityService } from '../src/summarize-entity/summarize-entity.service';

describe('SummarizeEntityService — watermark freshness', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let entityId = '';

  const ingest = async (
    predicate: string,
    object: string,
    validFrom: string,
  ) => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'wm_subj' },
        predicate,
        object,
        validFrom,
        confidence: 0.95,
        source: { vertical: 'rent' },
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_summarize_wm_e2e' });
    const factId = await ingest('name', 'Watermark Subject', '2026-01-01T00:00:00Z');
    const surreal = f.app.get(SurrealService);
    entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::thing('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      return String((rows as any[])?.[0]?.entityId ?? '');
    });
    expect(entityId).toMatch(/^knowledge_entity:/);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('serves a repeated call from cache and exposes asOfValid', async () => {
    const svc = f.app.get(SummarizeEntityService);
    svc.clearCacheForTest();
    const first = await svc.summarize(f.companyId, { entityId }, ['brain:read']);
    expect(first.cached).toBe(false);
    expect(first.asOfValid).toBeDefined();
    const second = await svc.summarize(f.companyId, { entityId }, ['brain:read']);
    expect(second.cached).toBe(true);
  });

  it('rebuilds after a backfilled fact (newer recordedAt, past validFrom)', async () => {
    const svc = f.app.get(SummarizeEntityService);
    const before = await svc.summarize(f.companyId, { entityId }, ['brain:read']);
    expect(before.cached).toBe(true); // warm from the previous test's build
    const factsBefore = before.factsConsidered;

    // Backfill: validFrom a YEAR in the past, but recordedAt is now. An
    // asOf-keyed cache would happily keep serving the stale summary; the
    // wall-clock watermark must catch it.
    await ingest('tier', 'gold', '2025-01-01T00:00:00Z');

    const after = await svc.summarize(f.companyId, { entityId }, ['brain:read']);
    expect(after.cached).toBe(false);
    expect(after.factsConsidered).toBe(factsBefore + 1);
    expect(after.asOfValid).toBeDefined();
  });
});
