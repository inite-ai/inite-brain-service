/**
 * SummarizeEntityService — integration smoke
 *
 * Seeds an entity with a few facts, calls summarize twice, asserts:
 *   - first call returns a one-liner that mentions the canonical name +
 *     at least one fact
 *   - second call returns the SAME briefing with cached: true
 *   - different styleHint produces a distinct cache key (miss)
 *   - asOf cutoff before any fact gives the "no active facts" branch
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SummarizeEntityService } from '../src/summarize-entity/summarize-entity.service';

describe('SummarizeEntityService.summarize — briefings + LRU', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let entityId = '';

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_summarize_e2e' });

    const factA = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'summarize_subj' },
        predicate: 'name',
        object: 'Sasha Customer',
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.95,
        source: { vertical: 'rent' },
      });
    expect([200, 201]).toContain(factA.status);

    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'summarize_subj' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.9,
        source: { vertical: 'rent' },
      });

    // Resolve the brain-allocated entityId from the ingested factId so
    // the summarize call gets the right knowledge_entity:<tail>.
    const factId = factA.body.factId as string;
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

  beforeEach(() => {
    const svc = f.app.get(SummarizeEntityService);
    svc.clearCacheForTest();
  });

  it('returns a one-liner that mentions the canonical name and a fact', async () => {
    const svc = f.app.get(SummarizeEntityService);
    const out = await svc.summarize(
      f.companyId,
      { entityId },
      ['brain:read'],
    );
    expect(out.summary).toContain('Sasha Customer');
    // At least one fact predicate present in the rendered line.
    expect(out.summary).toMatch(/tier|name/);
    expect(out.factsConsidered).toBeGreaterThanOrEqual(1);
    expect(out.cached).toBe(false);
    expect(out.style).toBe('neutral');
  });

  it('second call with same args is served from cache', async () => {
    const svc = f.app.get(SummarizeEntityService);
    const first = await svc.summarize(f.companyId, { entityId }, [
      'brain:read',
    ]);
    expect(first.cached).toBe(false);
    const second = await svc.summarize(f.companyId, { entityId }, [
      'brain:read',
    ]);
    expect(second.cached).toBe(true);
    expect(second.summary).toBe(first.summary);
  });

  it('different styleHint misses the cache and yields a distinct briefing', async () => {
    const svc = f.app.get(SummarizeEntityService);
    const neutral = await svc.summarize(
      f.companyId,
      { entityId, styleHint: 'neutral' },
      ['brain:read'],
    );
    const sales = await svc.summarize(
      f.companyId,
      { entityId, styleHint: 'sales' },
      ['brain:read'],
    );
    expect(sales.cached).toBe(false);
    expect(sales.summary).not.toBe(neutral.summary);
    expect(sales.style).toBe('sales');
  });

  it('asOf before any fact returns the no-active-facts branch', async () => {
    const svc = f.app.get(SummarizeEntityService);
    const out = await svc.summarize(
      f.companyId,
      { entityId, asOf: '2025-06-01T00:00:00Z' },
      ['brain:read'],
    );
    expect(out.summary).toMatch(/no active facts/i);
    expect(out.factsConsidered).toBe(0);
  });
});
