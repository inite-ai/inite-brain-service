/**
 * Release blocker (audit 2026-08-21 P1): reranker priority used to
 * override the fused rankScore ORDER unconditionally, erasing the
 * trust prior (SEARCH_TRUST_BETA rides the fused score). Pins the band
 * contract: rerank stages reorder only WITHIN a fused-score band; a
 * gap wider than the band survives; band 0 restores the old behavior.
 */
import { SearchRerankService } from '../src/search/search-rerank.service';
import type { EntityBucket } from '../src/search/internals/types';
import type { PipelineContext } from '../src/search/pipeline-context';
import type { RerankerService } from '../src/ai/reranker.service';
import type { CrossEncoderService } from '../src/ai/cross-encoder.service';

function bucket(entityId: string, rankScore: number): EntityBucket {
  return {
    entityId,
    rankScore,
    facts: [
      {
        score: rankScore,
        row: {
          predicate: 'p',
          object: `fact of ${entityId}`,
          entity: { type: 'other', canonicalName: entityId },
        },
      },
    ],
  } as unknown as EntityBucket;
}

/** Cross-encoder stub that always INVERTS the candidate order. */
const invertingCrossEncoder = {
  isEnabled: () => true,
  isLocalOnly: () => false,
  rerank: async (_q: string, inputs: unknown[]) => inputs.map((_, i) => inputs.length - 1 - i),
} as unknown as CrossEncoderService;

const disabledReranker = {
  isEnabled: () => false,
} as unknown as RerankerService;

function ctxWith(trustBand: number): PipelineContext {
  return {
    limit: 5,
    dto: { query: 'test query' },
    tuning: { rerankTrustBand: trustBand, rerankSkipMargin: 0 },
  } as unknown as PipelineContext;
}

async function run(trustBand: number): Promise<string[]> {
  const svc = new SearchRerankService(disabledReranker, invertingCrossEncoder);
  // Trusted source 0.471 vs neutral 0.325 — the exact audit repro: the
  // trust factor moved the score, the cross-encoder erased the order.
  const byEntity = new Map([
    ['trusted', bucket('trusted', 0.471)],
    ['neutral', bucket('neutral', 0.325)],
  ]);
  const out = await svc.runRerankStage({ byEntity, ctx: ctxWith(trustBand) });
  return out.map((b) => b.entityId);
}

describe('rerank trust band (audit 2026-08-21 P1)', () => {
  it('a fused-score gap wider than the band survives the cross-encoder', async () => {
    await expect(run(0.1)).resolves.toEqual(['trusted', 'neutral']);
  });

  it('band 0 restores absolute reranker priority (documented off switch)', async () => {
    await expect(run(0)).resolves.toEqual(['neutral', 'trusted']);
  });

  it('within one band the cross-encoder order wins', async () => {
    const svc = new SearchRerankService(disabledReranker, invertingCrossEncoder);
    const byEntity = new Map([
      ['a', bucket('a', 0.4201)],
      ['b', bucket('b', 0.4209)],
    ]);
    const out = await svc.runRerankStage({ byEntity, ctx: ctxWith(0.1) });
    // The stage feeds the CE a score-sorted window [b, a]; the stub
    // inverts it to [a, b]. Same 0.1 band → that CE order stands.
    expect(out.map((x) => x.entityId)).toEqual(['a', 'b']);
  });
});
