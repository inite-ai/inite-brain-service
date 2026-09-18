/**
 * The rerank stage runs the fact-level cross-encoder pass BESIDE the LLM
 * rerank, not after it (src/search/search-rerank.service.ts).
 *
 * Both passes used to run in sequence after the LLM call, so a search on
 * the production host paid entity-CE + LLM + fact-CE end to end. The
 * local worker is serial and idle while the LLM call waits on the
 * network — the fact pass fits in that gap. Pins:
 *  - the fact pass is STARTED after the entity pass and before the LLM
 *    reranker is invoked;
 *  - its remap is APPLIED only after the LLM reranker returns (the LLM
 *    body was built from the fused scores, as before);
 *  - the remap itself still lands (the fact-centric cut sees it);
 *  - with the pass off, the cross-encoder is asked once.
 */
import { SearchRerankService } from '../src/search/search-rerank.service';
import type { EntityBucket } from '../src/search/internals/types';
import type { PipelineContext } from '../src/search/pipeline-context';
import type { RerankerService } from '../src/ai/reranker.service';
import type { CrossEncoderService } from '../src/ai/cross-encoder.service';

function bucket(entityId: string, scores: number[]): EntityBucket {
  return {
    entityId,
    rankScore: Math.max(...scores),
    facts: scores.map((score, i) => ({
      score,
      row: {
        predicate: `p${i}`,
        object: `fact ${i} of ${entityId}`,
        entity: { type: 'other', canonicalName: entityId },
      },
    })),
  } as unknown as EntityBucket;
}

function ctx(factRerank: boolean): PipelineContext {
  return {
    limit: 1,
    dto: { query: 'q' },
    profile: { factRerank },
    tuning: { rerankTrustBand: 0, rerankSkipMargin: 0, factRerankWindow: 64 },
  } as unknown as PipelineContext;
}

describe('rerank stage — the fact pass rides beside the LLM rerank', () => {
  it('starts the fact pass after the entity pass and before the LLM call; remaps after it', async () => {
    const events: string[] = [];
    let releaseFact!: () => void;
    const factDone = new Promise<void>((r) => (releaseFact = r));
    const byEntity = new Map([
      ['a', bucket('a', [0.9, 0.2])],
      ['b', bucket('b', [0.8, 0.1])],
    ]);
    const crossEncoder = {
      isEnabled: () => true,
      isLocalOnly: () => true,
      rerank: jest.fn(async (_q: string, inputs: Array<{ label: string }>) => {
        // The entity pass sees "<name> [type]" labels; the fact pass sees
        // "<name> — <predicate>" labels.
        if (inputs[0]!.label.includes(' [')) {
          events.push('ce:entity');
          return inputs.map((_, i) => i);
        }
        events.push('ce:fact:start');
        await factDone;
        events.push('ce:fact:end');
        // Invert the 4-fact window: the lowest fused fact becomes top.
        return inputs.map((_, i) => inputs.length - 1 - i);
      }),
    } as unknown as CrossEncoderService;
    const reranker = {
      isEnabled: () => true,
      rerank: jest.fn(async (_q: string, inputs: Array<{ body: string }>) => {
        events.push('llm');
        // The LLM body was built from the FUSED order — the fact pass has
        // not remapped anything yet (it is still parked on factDone).
        expect(inputs[0]!.body.startsWith('- p0: fact 0 of a')).toBe(true);
        releaseFact();
        return inputs.map((_, i) => i);
      }),
    } as unknown as RerankerService;

    const svc = new SearchRerankService(reranker, crossEncoder);
    const out = await svc.runRerankStage({ byEntity, ctx: ctx(true) });

    expect(events).toEqual(['ce:entity', 'ce:fact:start', 'llm', 'ce:fact:end']);
    expect(out.map((b) => b.entityId)).toEqual(['a', 'b']);
    // The remap landed: the window's score SET is preserved and the
    // inverted permutation gave the lowest fused fact the highest value.
    const scores = [...byEntity.values()].flatMap((b) => b.facts.map((f) => f.score));
    expect([...scores].sort((x, y) => y - x)).toEqual([0.9, 0.8, 0.2, 0.1]);
    expect(byEntity.get('b')!.facts[1]!.score).toBe(0.9);
    expect(byEntity.get('a')!.facts[0]!.score).toBe(0.1);
  });

  it('the LLM reranker is skipped when every candidate fits the caller limit', async () => {
    const byEntity = new Map([
      ['a', bucket('a', [0.9, 0.2])],
      ['b', bucket('b', [0.8, 0.1])],
    ]);
    const crossEncoder = {
      isEnabled: () => false,
      isLocalOnly: () => false,
      rerank: jest.fn(),
    } as unknown as CrossEncoderService;
    const reranker = {
      isEnabled: () => true,
      rerank: jest.fn(async (_q: string, inputs: unknown[]) => inputs.map((_, i) => i)),
    } as unknown as RerankerService;
    const metrics = { countRerank: jest.fn(), countCrossEncoder: jest.fn() };
    const svc = new SearchRerankService(reranker, crossEncoder, metrics as never);
    // Two candidates, limit 5: nothing to cut, so nothing to order.
    const fits = await svc.runRerankStage({ byEntity, ctx: { ...ctx(false), limit: 5 } as never });
    expect(fits.map((b) => b.entityId)).toEqual(['a', 'b']);
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(metrics.countRerank).toHaveBeenCalledWith('skipped_all_fit');
    // Limit 1: the cut is real, the reranker runs.
    await svc.runRerankStage({ byEntity, ctx: { ...ctx(false), limit: 1 } as never });
    expect(reranker.rerank).toHaveBeenCalledTimes(1);
  });

  it('with the fact pass off, the cross-encoder is asked once and scores are untouched', async () => {
    const byEntity = new Map([
      ['a', bucket('a', [0.9, 0.2])],
      ['b', bucket('b', [0.8, 0.1])],
    ]);
    const crossEncoder = {
      isEnabled: () => true,
      isLocalOnly: () => true,
      rerank: jest.fn(async (_q: string, inputs: unknown[]) => inputs.map((_, i) => i)),
    } as unknown as CrossEncoderService;
    const reranker = { isEnabled: () => false } as unknown as RerankerService;
    await new SearchRerankService(reranker, crossEncoder).runRerankStage({
      byEntity,
      ctx: ctx(false),
    });
    expect(crossEncoder.rerank).toHaveBeenCalledTimes(1);
    expect(byEntity.get('a')!.facts.map((f) => f.score)).toEqual([0.9, 0.2]);
  });
});
