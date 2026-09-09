import { ServiceUnavailableException } from '@nestjs/common';
import { ExtractorService } from '../src/ai/extractor.service';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import { ExtractorLlmService } from '../src/ai/extractor-llm.service';
import { ExtractorLocalService } from '../src/ai/extractor-local.service';
import { ExtractorRefineService } from '../src/ai/extractor-refine.service';

/**
 * V-10 of the #501-wave review: the transition-classifier lane embeds its
 * prototype bank and the input clauses through `EmbedderService.embedMany`
 * — the READ path, which answers 503 while the bge-m3 primary is warming
 * up (strict space guard) or when it has no fallback. That 503 must cost
 * the extraction the transition lane and nothing else: the LLM facts are
 * kept, the failure is a warning, and the NEXT extraction retries the bank
 * (a failed bank embedding is not memoised).
 */

function mkExtractor(embedMany: jest.Mock, scripted: unknown[]) {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'EXTRACTOR_SC_PASSES') return '1';
      if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'OPENAI_CONCURRENCY') return '8';
      return def;
    },
    getOrThrow: (k: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      throw new Error(`getOrThrow missing: ${k}`);
    },
  } as never;
  const registry = {
    getSnapshot: async () => ({ versionHash: 'h', active: [] }),
  } as never;
  const localPredicates = { selectForExtraction: async () => null } as never;
  const extractionCache = { computeKey: () => 'k', get: () => undefined, set: () => {} } as never;
  const localNer = { isEnabled: () => false, extract: async () => [] } as never;
  const extractionPatterns = { lookup: async () => undefined, record: async () => {} } as never;

  const llm = new ExtractorLlmService(config);
  let call = 0;
  (llm as unknown as { callLlm: () => Promise<unknown> }).callLlm = async () =>
    scripted[call++ % scripted.length];
  const local = new ExtractorLocalService(localNer, extractionPatterns);
  (local as unknown as { trySkip: () => Promise<null> }).trySkip = async () => null;
  const refine = new ExtractorRefineService(registry, localPredicates);
  const embedder = { embedMany } as never;
  const runner = new ExtractorRunnerService(llm, local, refine, embedder);
  const warn = jest.spyOn(
    (runner as unknown as { logger: { warn: (m: string) => void } }).logger,
    'warn',
  );
  return { svc: new ExtractorService(extractionCache, registry, runner), warn };
}

const ONE_FACT = {
  entities: [{ name: 'Alice', type: 'customer' }],
  facts: [
    {
      entityIndex: 0,
      clauseIndex: 0,
      predicate: 'lives_in',
      valueSpan: 'Berlin',
      confidence: 0.9,
    },
  ],
  clauses: [{ index: 0, span: 'Alice moved to Berlin last week' }],
  edges: [],
};

describe('extractor — transition-classifier lane under an embedder 503', () => {
  beforeEach(() => {
    process.env.EXTRACTOR_TRANSITION_CLASSIFIER = '1';
  });
  afterEach(() => {
    delete process.env.EXTRACTOR_TRANSITION_CLASSIFIER;
  });

  it('a 503 from embedMany drops the lane with a warning and keeps every other fact', async () => {
    const embedMany = jest.fn(async () => {
      throw new ServiceUnavailableException(
        'embedding space strict-guard: refusing to serve a query — the primary embedder is not ready',
      );
    });
    const { svc, warn } = mkExtractor(embedMany, [ONE_FACT]);
    const res = await svc.extract('Alice moved to Berlin last week', 'co_test');
    expect(res.facts.map((f) => f.predicate)).toEqual(['lives_in']);
    expect(embedMany).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/transition-classifier lane failed \(facts from other lanes kept\)/),
    );
  });

  it('the failed bank is not memoised — the next extraction retries once the embedder is back', async () => {
    let calls = 0;
    const embedMany = jest.fn(async (texts: string[]) => {
      calls += 1;
      if (calls === 1) throw new ServiceUnavailableException('primary embedder is not ready');
      return texts.map(() => [1, 0, 0, 0]);
    });
    const { svc } = mkExtractor(embedMany, [ONE_FACT]);
    await svc.extract('Alice moved to Berlin last week', 'co_test');
    const before = embedMany.mock.calls.length;
    await svc.extract('Alice moved to Berlin last week', 'co_test');
    // The second extraction embedded again (bank + inputs), i.e. the lane
    // came back on its own rather than staying dead until a restart.
    expect(embedMany.mock.calls.length).toBeGreaterThan(before);
  });
});
