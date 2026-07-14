/**
 * Wave P2 of the 2026-07 performance audit — hot-path regression guards.
 *
 * 1. tokenBudget shaping must stay a hard ceiling while running one
 *    tiktoken pass per hit (the old loop re-encoded the entire payload
 *    after every pop — O(N) full encodes on the main thread).
 * 2. Empty/whitespace queries short-circuit to an empty result before
 *    any embedding or DB work.
 * 3. The query embedding is warmed BEFORE the scoped pool connection is
 *    acquired, so the external embed round-trip never extends hold time
 *    on the 8-slot pool.
 */
import { applyOutputShaping } from '../src/search/internals/response-builder';
import { countJsonTokens } from '../src/common/token-counter';
import { SearchService } from '../src/search/search.service';
import type { SearchHit } from '../src/search/search.types';
import type { SearchDto } from '../src/search/dto/search.dto';

function mkHit(i: number, pad = 40): SearchHit {
  return {
    entityId: `knowledge_entity:e${i}`,
    entityType: 'person',
    canonicalName: `Entity ${i} ${'x'.repeat(pad)}`,
    externalRefs: {},
    facts: [
      {
        factId: `knowledge_fact:f${i}`,
        predicate: 'title',
        object: `value ${i} ${'y'.repeat(pad)}`,
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
        score: 0.5,
      },
    ],
    score: 1 - i / 100,
  } as unknown as SearchHit;
}

describe('applyOutputShaping tokenBudget (one-pass)', () => {
  const hits = Array.from({ length: 40 }, (_, i) => mkHit(i));

  it('keeps the result under the budget', () => {
    const out = applyOutputShaping(hits, {
      query: 'q',
      tokenBudget: 500,
    } as SearchDto);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(hits.length);
    expect(countJsonTokens({ results: out })).toBeLessThanOrEqual(500);
  });

  it('keeps a prefix (never reorders or samples)', () => {
    const out = applyOutputShaping(hits, {
      query: 'q',
      tokenBudget: 800,
    } as SearchDto);
    out.forEach((hit, i) => {
      expect(hit.entityId).toBe(hits[i].entityId);
    });
  });

  it('returns everything when the budget is ample', () => {
    const out = applyOutputShaping(hits.slice(0, 3), {
      query: 'q',
      tokenBudget: 100_000,
    } as SearchDto);
    expect(out).toHaveLength(3);
  });

  it('returns nothing when even one hit cannot fit', () => {
    const out = applyOutputShaping(hits, {
      query: 'q',
      tokenBudget: 3,
    } as SearchDto);
    expect(out).toHaveLength(0);
  });
});

describe('SearchService empty-query short-circuit + embed prewarm', () => {
  function mkService(overrides: {
    withScopedCompany?: jest.Mock;
    prewarm?: jest.Mock;
  }) {
    const withScopedCompany =
      overrides.withScopedCompany ??
      jest.fn(async () => ({ results: [] as SearchHit[] }));
    const prewarm = overrides.prewarm ?? jest.fn(async () => undefined);
    const surreal = { withScopedCompany } as never;
    const retrieval = {
      prewarmQueryEmbedding: prewarm,
      runRetrievalStage: jest.fn(async () => []),
    } as never;
    const rerank = {} as never;
    return { svc: new SearchService(surreal, retrieval, rerank), withScopedCompany, prewarm };
  }

  it('returns empty results for a whitespace query without touching the DB', async () => {
    const { svc, withScopedCompany, prewarm } = mkService({});
    const out = await svc.search('co_x', { query: '   ' } as SearchDto, [
      'brain:read',
    ]);
    expect(out).toEqual({ results: [] });
    expect(withScopedCompany).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('warms the query embedding before acquiring the scoped connection', async () => {
    const order: string[] = [];
    const prewarm = jest.fn(async () => {
      order.push('prewarm');
    });
    const withScopedCompany = jest.fn(async () => {
      order.push('scoped');
      return { results: [] as SearchHit[] };
    });
    const { svc } = mkService({ withScopedCompany, prewarm });
    await svc.search('co_x', { query: 'hello' } as SearchDto, ['brain:read']);
    expect(order).toEqual(['prewarm', 'scoped']);
  });

  it('skips the prewarm for lexical-only mode', async () => {
    const { svc, prewarm } = mkService({});
    await svc.search(
      'co_x',
      { query: 'hello', searchMode: 'lexical' } as SearchDto,
      ['brain:read'],
    );
    expect(prewarm).not.toHaveBeenCalled();
  });
});
