/**
 * Regression for the #64 refactor: a transient LLM failure (runner
 * returns null — null/non-JSON response or all SC passes failed) must
 * NOT be memoised. The extraction cache is a no-TTL LRU keyed on
 * (text, tenant, vocabHash, scPasses); caching the empty result would
 * pin "this text contains no facts" for every identical re-ingest
 * until eviction. Pre-#64 the failure paths returned before cache.set.
 */
import { ConfigService } from '@nestjs/config';
import { ExtractorService } from '../src/ai/extractor.service';
import { ExtractorCacheService } from '../src/ai/extractor-cache.service';
import type { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { ExtractionResult } from '../src/ai/extractor.service';

const TEXT = 'Maria Petrov is our new CTO at Acme.';
const COMPANY = 'co_test';

const realResult: ExtractionResult = {
  entities: [{ name: 'Maria Petrov', type: 'staff' }],
  facts: [{ entityIndex: 0, predicate: 'status', object: 'CTO', confidence: 0.9 }],
  edges: [],
};

function build(runResults: Array<ExtractionResult | null>) {
  const cache = new ExtractorCacheService({
    get: (_k: string, def?: string) => def,
  } as unknown as ConfigService);
  let calls = 0;
  const runner = {
    scPasses: 1,
    modelId: () => 'stub-model',
    run: async () => {
      const r = runResults[Math.min(calls, runResults.length - 1)];
      calls += 1;
      return r;
    },
  } as unknown as ExtractorRunnerService;
  const registry = {
    getSnapshot: async () => ({ versionHash: 'v-test', active: [] }),
  } as unknown as PredicateRegistryService;
  const svc = new ExtractorService(cache, registry, runner);
  return { svc, cache, callCount: () => calls };
}

describe('ExtractorService — LLM-failure results are never cached', () => {
  it('returns empty on runner null but re-runs on the next identical call', async () => {
    const { svc, callCount } = build([null, realResult]);

    const first = await svc.extract(TEXT, COMPANY);
    expect(first).toEqual({ entities: [], facts: [], edges: [] });

    // Identical input again: a poisoned cache would replay the empty
    // result; the fix retries the runner and gets the real extraction.
    const second = await svc.extract(TEXT, COMPANY);
    expect(second).toEqual(realResult);
    expect(callCount()).toBe(2);
  });

  it('still caches successful extractions (including legitimately empty ones)', async () => {
    const empty: ExtractionResult = { entities: [], facts: [], edges: [] };
    const { svc, callCount } = build([empty]);

    await svc.extract(TEXT, COMPANY);
    await svc.extract(TEXT, COMPANY);
    // Second call served from cache — an assembled empty result means
    // "the text really contains nothing", which IS cacheable.
    expect(callCount()).toBe(1);
  });
});
