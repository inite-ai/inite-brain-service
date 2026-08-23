import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { clusterKey } from '../src/ai/extractor-internals/semantic-entropy';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import type { ExtractorLlmService } from '../src/ai/extractor-llm.service';

/**
 * Audit W3 #5 (engine-architecture-audit-2026-08.md): the merge deduped
 * facts on (predicate, object) with a GLOBAL seen-set, ignoring which
 * entity the fact was about. Two people sharing a value collided and one
 * fact was silently dropped — precisely what the entity facet pass
 * produces.
 */
function pass(
  entities: Array<{ name: string; type: string }>,
  facts: Array<{ entityIndex: number; predicate: string; object: string }>,
): ExtractionResult {
  return {
    entities: entities as ExtractionResult['entities'],
    facts: facts.map((f) => ({ ...f, confidence: 0.9 })),
    edges: [],
  };
}

describe('merge keeps same-value facts of different entities (W3 #5)', () => {
  it('two people living in Berlin both survive', () => {
    const merged = mergeExtractions([
      pass(
        [
          { name: 'Anna', type: 'customer' },
          { name: 'Boris', type: 'customer' },
        ],
        [
          { entityIndex: 0, predicate: 'address', object: 'Berlin' },
          { entityIndex: 1, predicate: 'address', object: 'Berlin' },
        ],
      ),
    ]);
    expect(merged.facts).toHaveLength(2);
    expect(new Set(merged.facts.map((f) => f.entityIndex))).toEqual(new Set([0, 1]));
  });

  it('the SAME entity+value across passes still dedupes to one', () => {
    const merged = mergeExtractions([
      pass(
        [{ name: 'Anna', type: 'customer' }],
        [{ entityIndex: 0, predicate: 'address', object: 'Berlin' }],
      ),
      pass(
        [{ name: 'Anna', type: 'customer' }],
        [{ entityIndex: 0, predicate: 'address', object: 'berlin ' }],
      ),
    ]);
    expect(merged.facts).toHaveLength(1);
  });

  it('clusterKey separates entities and still normalises the object', () => {
    expect(clusterKey({ predicate: 'p', object: 'Berlin', entity: 0 })).not.toBe(
      clusterKey({ predicate: 'p', object: 'Berlin', entity: 1 }),
    );
    expect(clusterKey({ predicate: 'p', object: ' Berlin ', entity: 0 })).toBe(
      clusterKey({ predicate: 'p', object: 'berlin', entity: 0 }),
    );
  });
});

describe('facet routing requires the dialogue profile (W3 #6)', () => {
  const saved = {
    routing: process.env.EXTRACTOR_ROUTING_ENABLED,
    dialogue: process.env.EXTRACTOR_DIALOGUE_PROFILE,
  };
  afterEach(() => {
    if (saved.routing === undefined) delete process.env.EXTRACTOR_ROUTING_ENABLED;
    else process.env.EXTRACTOR_ROUTING_ENABLED = saved.routing;
    if (saved.dialogue === undefined) delete process.env.EXTRACTOR_DIALOGUE_PROFILE;
    else process.env.EXTRACTOR_DIALOGUE_PROFILE = saved.dialogue;
  });

  function makeRunner(calls: string[]): ExtractorRunnerService {
    const llm = {
      modelId: () => 'gpt-4o-mini',
      scPasses: 1,
      composeSystemPrompt: () => 'SYSTEM',
      callLlm: async (a: { systemPrompt: string }) => {
        calls.push(a.systemPrompt);
        return { clauses: [], entities: [], facts: [], edges: [] };
      },
    } as unknown as ExtractorLlmService;
    const local = {
      trySkip: async () => null,
      persistPatterns: async () => undefined,
    } as never;
    const refine = {
      applyPredicateRefinements: async () => undefined,
    } as never;
    return new ExtractorRunnerService(llm, local, refine);
  }

  const listy = 'I bought apples, pears, plums and figs at the market';

  it('routing ON + dialogue OFF → ONE call (facet passes would be dropped)', async () => {
    process.env.EXTRACTOR_ROUTING_ENABLED = '1';
    delete process.env.EXTRACTOR_DIALOGUE_PROFILE;
    const calls: string[] = [];
    await makeRunner(calls).run({
      trimmed: listy,
      companyId: 'co_x',
      snapshot: { versionHash: 'v', active: [] },
    });
    expect(calls).toHaveLength(1);
  });

  it('routing ON + dialogue ON → the specialist passes run', async () => {
    process.env.EXTRACTOR_ROUTING_ENABLED = '1';
    process.env.EXTRACTOR_DIALOGUE_PROFILE = '1';
    const calls: string[] = [];
    await makeRunner(calls).run({
      trimmed: listy,
      companyId: 'co_x',
      snapshot: { versionHash: 'v', active: [] },
    });
    expect(calls.length).toBeGreaterThan(1);
  });
});
