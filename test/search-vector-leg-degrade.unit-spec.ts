/**
 * Vector-leg degradation (review 2026-09-09, V-1 / V-2 read side).
 *
 * A hybrid search whose query cannot be embedded, or whose similarity
 * statement fails, answers lexical-only and says so on the response —
 * instead of 503'ing every hybrid search for as long as the embedder is
 * down or the corpus is in another space.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SearchRetrievalService } from '../src/search/search-retrieval.service';
import { resolveSearchTuning } from '../src/search/retrieval-profile';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { CalibrationService } from '../src/ai/calibration/calibration.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import type { PipelineContext } from '../src/search/pipeline-context';

const LEX = {
  id: 'knowledge_fact:f1',
  entityId: 'knowledge_entity:e1',
  predicate: 'likes',
  object: 'cats',
  confidence: 0.9,
  bm25Score: 2.5,
};

/** A db whose answer is chosen by a substring of the statement. */
function dbWith(perMarker: Record<string, unknown[] | Error>): Surreal {
  return {
    query: async (sql: string) => {
      for (const [marker, answer] of Object.entries(perMarker)) {
        if (!sql.includes(marker)) continue;
        if (answer instanceof Error) throw answer;
        return [answer];
      }
      return [[]];
    },
  } as unknown as Surreal;
}

function mkSvc(embedder: Partial<EmbedderService>, inc = jest.fn()) {
  const metrics = { searchVectorLegDegraded: { inc } } as unknown as MetricsService;
  const svc = new SearchRetrievalService(
    embedder as EmbedderService,
    { calibrate: (x: number) => x } as unknown as CalibrationService,
    metrics,
  );
  return { svc, inc };
}

function ctxOf(mode: 'hybrid' | 'vector' | 'lexical'): PipelineContext {
  return {
    dto: { query: 'cats' },
    mode,
    candidateK: 10,
    companyId: 'co_x',
    callerScopes: ['brain:read'],
    tuning: resolveSearchTuning(),
    degraded: new Set(),
  } as unknown as PipelineContext;
}

const BASE = { sql: '', params: {} };
const refusing = {
  embed: async () => Promise.reject(new ServiceUnavailableException('strict guard')),
};

describe('SearchRetrievalService vector-leg degradation', () => {
  it('hybrid: an embedder 503 degrades to lexical-only and marks the request', async () => {
    const { svc, inc } = mkSvc(refusing);
    const ctx = ctxOf('hybrid');
    const rows = await svc.runRetrievalStage(dbWith({ 'search::score': [LEX] }), ctx, BASE);
    expect(rows.map((r) => String(r.id))).toEqual(['knowledge_fact:f1']);
    expect([...ctx.degraded!]).toEqual(['vector_leg']);
    expect(inc).toHaveBeenCalledWith({ reason: 'embedder_unavailable' });
  });

  it('hybrid: a failing similarity statement (rows not in the query space) degrades too', async () => {
    const { svc, inc } = mkSvc({ embed: async () => [0.1, 0.2] });
    const ctx = ctxOf('hybrid');
    const db = dbWith({
      'vector::similarity::cosine': new Error('The two vectors must be of the same dimension'),
      'search::score': [LEX],
    });
    const rows = await svc.runRetrievalStage(db, ctx, BASE);
    expect(rows.map((r) => String(r.id))).toEqual(['knowledge_fact:f1']);
    expect([...ctx.degraded!]).toEqual(['vector_leg']);
    expect(inc).toHaveBeenCalledWith({ reason: 'vector_query_failed' });
  });

  it('vector-only has nothing to degrade to and still fails', async () => {
    const { svc, inc } = mkSvc(refusing);
    const ctx = ctxOf('vector');
    await expect(
      svc.runRetrievalStage(dbWith({ 'search::score': [LEX] }), ctx, BASE),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(ctx.degraded!.size).toBe(0);
    expect(inc).not.toHaveBeenCalled();
  });

  it('a healthy vector leg leaves the request undegraded', async () => {
    const { svc, inc } = mkSvc({ embed: async () => [0.1, 0.2] });
    const ctx = ctxOf('hybrid');
    const db = dbWith({
      'vector::similarity::cosine': [{ ...LEX, id: 'knowledge_fact:f2', simScore: 0.8 }],
      'search::score': [LEX],
    });
    const rows = await svc.runRetrievalStage(db, ctx, BASE);
    expect(rows.map((r) => String(r.id)).sort()).toEqual([
      'knowledge_fact:f1',
      'knowledge_fact:f2',
    ]);
    expect(ctx.degraded!.size).toBe(0);
    expect(inc).not.toHaveBeenCalled();
  });

  it('lexical mode never touches the embedder', async () => {
    const embed = jest.fn();
    const { svc } = mkSvc({ embed });
    const ctx = ctxOf('lexical');
    const rows = await svc.runRetrievalStage(dbWith({ 'search::score': [LEX] }), ctx, BASE);
    expect(rows).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
    expect(ctx.degraded!.size).toBe(0);
  });
});
