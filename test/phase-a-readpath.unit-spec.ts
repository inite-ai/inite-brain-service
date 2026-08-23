import { mergeExtraHits } from '../src/synthesize/evidence-union';
import { buildGeneratorUserMessage } from '../src/synthesize/synthesize.service';
import { selectFactCentric } from '../src/search/internals/fact-centric';
import { MultiHopService } from '../src/multi-hop/multi-hop.service';
import { MultiHopChainService } from '../src/multi-hop/multi-hop-chain.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type {
  MultiHopPlannerService,
  MultiHopPlan,
} from '../src/multi-hop/multi-hop-planner.service';
import type { SynthesizeService, SynthesizeOptions } from '../src/synthesize/synthesize.service';
import type { MultiHopDto } from '../src/multi-hop/dto/multi-hop.dto';
import type { EntityBucket, ScoredRow } from '../src/search/internals/types';

function hit(entityId: string, facts: Array<[string, number]>): SearchHit {
  return {
    entityId,
    entityType: 'person',
    canonicalName: entityId,
    externalRefs: {},
    facts: facts.map(([factId, score]) => ({
      factId,
      predicate: 'p',
      object: factId,
      confidence: 0.9,
      validFrom: '2023-01-01T00:00:00Z',
      status: 'active',
      score,
    })),
    score: facts[0]?.[1] ?? 0,
  };
}

describe('mergeExtraHits (evidence union)', () => {
  it('appends unseen extra facts after base, best-score-first, capped', () => {
    const base = [hit('e1', [['f1', 0.9]])];
    const extra = [
      hit('e2', [
        ['f2', 0.3],
        ['f3', 0.8],
        ['f4', 0.5],
      ]),
    ];
    const out = mergeExtraHits(base, extra, 2);
    expect(out.map((h) => h.entityId)).toEqual(['e1', 'e2']);
    // capped at 2, chosen by score: f3 (0.8), f4 (0.5); f2 dropped
    expect(out[1]!.facts.map((f) => f.factId)).toEqual(['f3', 'f4']);
  });

  it('never duplicates a fact already present in base', () => {
    const base = [hit('e1', [['f1', 0.9]])];
    const extra = [
      hit('e1', [
        ['f1', 0.9],
        ['f2', 0.4],
      ]),
    ];
    const out = mergeExtraHits(base, extra, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.facts.map((f) => f.factId)).toEqual(['f1', 'f2']);
  });

  it('merges extra facts into an existing base entity without reordering base facts', () => {
    const base = [
      hit('e1', [
        ['f1', 0.9],
        ['f2', 0.8],
      ]),
    ];
    const extra = [hit('e1', [['f9', 0.95]])];
    const out = mergeExtraHits(base, extra, 10);
    expect(out[0]!.facts.map((f) => f.factId)).toEqual(['f1', 'f2', 'f9']);
  });

  it('does not mutate base hits', () => {
    const base = [hit('e1', [['f1', 0.9]])];
    const extra = [hit('e1', [['f2', 0.5]])];
    mergeExtraHits(base, extra, 10);
    expect(base[0]!.facts).toHaveLength(1);
  });

  it('returns base unchanged for empty extras or zero cap', () => {
    const base = [hit('e1', [['f1', 0.9]])];
    expect(mergeExtraHits(base, [], 10)).toBe(base);
    expect(mergeExtraHits(base, [hit('e2', [['f2', 1]])], 0)).toBe(base);
  });

  it('dedupes the same fact appearing in multiple extra hits', () => {
    const base: SearchHit[] = [];
    const extra = [hit('e1', [['f1', 0.9]]), hit('e1', [['f1', 0.9]])];
    const out = mergeExtraHits(base, extra, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.facts).toHaveLength(1);
  });
});

describe('buildGeneratorUserMessage (date context)', () => {
  const base = {
    query: 'when did X happen?',
    factLines: ['[knowledge_fact:1] A (person) — p: v (as of 2023-05-01)'],
    answerLang: 'en',
  };

  it('without dateContext is byte-identical to the historical format', () => {
    expect(buildGeneratorUserMessage(base)).toBe(
      `Query: ${base.query}\n\nRetrieved facts:\n${base.factLines[0]}` +
        `\n\nLanguage policy: write your answer in en (ISO 639-1). Keep citation spans in their original language.`,
    );
  });

  it('with dateContext anchors Today between query and facts', () => {
    const msg = buildGeneratorUserMessage({ ...base, dateContext: '2023-06-09' });
    expect(msg).toContain('Today: 2023-06-09.');
    expect(msg.indexOf('Today:')).toBeGreaterThan(msg.indexOf('Query:'));
    expect(msg.indexOf('Today:')).toBeLessThan(msg.indexOf('Retrieved facts:'));
  });
});

describe('selectFactCentric', () => {
  function bucket(entityId: string, scores: number[]): EntityBucket {
    const facts: ScoredRow[] = scores.map((score, i) => ({
      row: {
        id: `knowledge_fact:${entityId}_${i}`,
        entityId,
        predicate: 'p',
        object: `${entityId}_${i}`,
        confidence: 0.9,
        validFrom: '2023-01-01T00:00:00Z',
        recordedAt: '2023-01-01T00:00:00Z',
        status: 'active',
        source: {},
        fusedScore: score,
      },
      score,
      breakdown: {
        fusedScore: score,
        confidence: 0.9,
        decay: 1,
        finalScore: score,
        stages: ['vector'],
      },
    }));
    return { entityId, rankScore: Math.max(...scores), bestScore: Math.max(...scores), facts };
  }

  it('lets a strong fact from a weak entity beat weak facts of a strong entity', () => {
    const buckets = [bucket('strong', [0.9, 0.2, 0.1]), bucket('weak', [0.8])];
    const out = selectFactCentric(buckets, 2);
    expect(out.map((b) => b.entityId)).toEqual(['strong', 'weak']);
    expect(out[0]!.facts).toHaveLength(1); // only the 0.9 made the cut
    expect(out[1]!.facts).toHaveLength(1); // 0.8 beat 0.2/0.1
  });

  it('orders rebuilt buckets by their best selected fact', () => {
    const out = selectFactCentric([bucket('a', [0.5]), bucket('b', [0.7])], 10);
    expect(out.map((b) => b.entityId)).toEqual(['b', 'a']);
  });

  it('respects the global budget across many entities', () => {
    const out = selectFactCentric(
      [bucket('a', [0.9, 0.8]), bucket('b', [0.7, 0.6]), bucket('c', [0.5])],
      3,
    );
    const total = out.reduce((n, b) => n + b.facts.length, 0);
    expect(total).toBe(3);
    expect(out.map((b) => b.entityId)).toEqual(['a', 'b']);
  });
});

describe('multi-hop hands hop evidence to synthesize (evidence union)', () => {
  function run(): Promise<SynthesizeOptions> {
    const hopHits = [hit('e1', [['f1', 0.9]]), hit('e2', [['f2', 0.8]])];
    const search = {
      search: async () => ({ results: hopHits }),
    } as unknown as SearchService;
    let captured: SynthesizeOptions | undefined;
    const synth = {
      synthesize: async (opts: SynthesizeOptions) => {
        captured = opts;
        return { answer: 'a', citations: [], results: [] };
      },
    } as unknown as SynthesizeService;
    const planner = {
      plan: async (): Promise<MultiHopPlan> => ({
        isMultiHop: false,
        hops: [
          {
            subQuery: 'refined',
            combination: 'seed',
            predicates: null,
            asOf: null,
            rationale: null,
          },
        ],
      }),
    } as unknown as MultiHopPlannerService;
    const svc = new MultiHopService(planner, new MultiHopChainService(search, synth));
    const dto = { query: 'q', synthesize: true } as MultiHopDto;
    return svc.run({ companyId: 'co_x', dto, callerScopes: ['brain:read'] }).then(() => {
      expect(captured).toBeDefined();
      return captured!;
    });
  }

  it('always passes hop hits as extraHits (union is how multi-hop hands off)', async () => {
    const opts = await run();
    expect(opts.extraHits).toBeDefined();
    expect(opts.extraHits!.map((h) => h.entityId)).toEqual(['e1', 'e2']);
  });
});
