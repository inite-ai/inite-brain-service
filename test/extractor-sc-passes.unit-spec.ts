/**
 * Unit-test for the N-pass self-consistency driver inside
 * ExtractorService. We exercise the multi-pass clustering / agreement
 * path without standing up a real OpenAI client — the LLM call is
 * mocked to return scripted JSON responses, one per pass.
 *
 * Closes the Phase 3.B audit gap: the semantic-entropy module shipped
 * + extractionEntropy column existed in migration 0019, but nothing
 * produced the entropy because the extractor only ran N=1.
 */
import { ExtractorService } from '../src/ai/extractor.service';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import { ExtractorLlmService } from '../src/ai/extractor-llm.service';
import { ExtractorLocalService } from '../src/ai/extractor-local.service';
import { ExtractorRefineService } from '../src/ai/extractor-refine.service';

function mkExtractor(scPasses: number, scripted: any[]): ExtractorService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'EXTRACTOR_SC_PASSES') return String(scPasses);
      if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      if (k === 'OPENAI_CONCURRENCY') return '8';
      return def;
    },
    getOrThrow: (k: string) => {
      if (k === 'OPENAI_API_KEY') return 'sk-test-stub';
      throw new Error(`getOrThrow missing: ${k}`);
    },
  } as any;
  const registry = {
    getSnapshot: async () => ({
      versionHash: 'h',
      active: [],
    }),
  } as any;
  const localPredicates = {
    selectForExtraction: async () => null,
  } as any;
  const extractionCache = {
    computeKey: () => 'k',
    get: () => undefined,
    set: () => {},
  } as any;
  const localNer = {
    isEnabled: () => false,
    extract: async () => [],
  } as any;
  const extractionPatterns = {
    lookup: async () => undefined,
    record: async () => {},
  } as any;

  const llm = new ExtractorLlmService(config);
  // Replace the private callLlm with a scripted stub. The driver
  // calls callLlm once per pass; scripted[i] is returned on pass i.
  let call = 0;
  (llm as any).callLlm = async () => scripted[call++ % scripted.length];
  const local = new ExtractorLocalService(localNer, extractionPatterns);
  // Short-circuit trySkip so the test exercises the LLM / multi-pass
  // branch directly.
  (local as any).trySkip = async () => null;
  const refine = new ExtractorRefineService(registry, localPredicates);
  const runner = new ExtractorRunnerService(llm, local, refine);
  return new ExtractorService(extractionCache, registry, runner);
}

describe('ExtractorService N-pass driver', () => {
  it('single-pass (default) does NOT attach extractionEntropy', async () => {
    // Single fact, identical predicate+object. With scPasses=1 we hit
    // the single-pass branch and the field stays absent.
    const svc = mkExtractor(1, [
      {
        entities: [{ name: 'A', type: 'customer' }],
        facts: [
          {
            entityIndex: 0,
            clauseIndex: 0,
            predicate: 'name',
            valueSpan: 'A',
            confidence: 0.9,
          },
        ],
        clauses: [{ index: 0, span: 'A' }],
        edges: [],
      },
    ]);
    const res = await svc.extract('hello A', 'co_test');
    expect(res.facts).toHaveLength(1);
    expect(res.facts[0].extractionEntropy).toBeUndefined();
    expect(res.facts[0].extractionAgreement).toBeUndefined();
  });

  it('three-pass consensus → entropy ≈ 0, agreement = 1', async () => {
    const allAgree = {
      entities: [{ name: 'A', type: 'customer' }],
      facts: [
        {
          entityIndex: 0,
          clauseIndex: 0,
          predicate: 'name',
          valueSpan: 'A',
          confidence: 0.9,
        },
      ],
      clauses: [{ index: 0, span: 'A' }],
      edges: [],
    };
    const svc = mkExtractor(3, [allAgree, allAgree, allAgree]);
    const res = await svc.extract('hello A', 'co_test');
    expect(res.facts).toHaveLength(1);
    expect(res.facts[0].extractionEntropy).toBeCloseTo(0, 3);
    expect(res.facts[0].extractionAgreement).toBe(1);
  });

  it('three-pass disagreement → positive entropy + agreement = 1/3', async () => {
    // valueSpan must exist verbatim in the text so applyGroundingGate
    // doesn't drop the rows. We use a text that contains every variant.
    // Entity name must also be span-grounded now, so use a name that
    // appears verbatim in the input ('Anna') rather than a bare 'A'.
    const make = (val: string) => ({
      entities: [{ name: 'Anna', type: 'customer' }],
      facts: [
        {
          entityIndex: 0,
          clauseIndex: 0,
          predicate: 'name',
          valueSpan: val,
          confidence: 0.9,
        },
      ],
      clauses: [{ index: 0, span: val }],
      edges: [],
    });
    const svc = mkExtractor(3, [make('Anna'), make('Boris'), make('Carla')]);
    const res = await svc.extract('Anna Boris Carla', 'co_test');
    // Three distinct clusters → entropy = log(3) nats. We expect three
    // facts (one exemplar per cluster) after the merge dedupe.
    expect(res.facts.length).toBe(3);
    for (const fact of res.facts) {
      expect(fact.extractionEntropy ?? 0).toBeGreaterThan(0.9);
      expect(fact.extractionAgreement).toBeCloseTo(1 / 3, 3);
    }
  });
});
