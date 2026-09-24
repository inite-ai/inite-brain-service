/**
 * Predicate cardinality decided by the extractor (the memory-context
 * contract): a coined predicate registers with the semantics the model
 * that read the sentence gave it — "one" → single_active, "many" →
 * append_only — and the semantics judge is asked only when no reading
 * came with the coinage.
 *  - the schema requires `cardinality` per fact; the parser carries a
 *    valid value and drops anything else;
 *  - the alias pass hands the registry the first fact's reading;
 *  - the registry's propose branch: reading present ⇒ no judge call and
 *    the row says who decided; absent ⇒ the judge, as before; a matched
 *    predicate ignores the reading.
 */
import { ConfigService } from '@nestjs/config';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { buildExtractionSchema } from '../src/ai/extractor-internals/prompts';
import { parseRawFacts } from '../src/ai/extractor-internals/grounding';
import { applyAliasPass } from '../src/ai/extractor-internals/predicate-canonicalize';
import type { ExtractedFact } from '../src/ai/extractor-internals/types';

describe('the contract in the schema and the parser', () => {
  it('cardinality is a required enum per fact', () => {
    const schema = buildExtractionSchema() as {
      properties: { facts: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    expect(schema.properties.facts.items.properties.cardinality).toMatchObject({
      type: 'string',
      enum: ['one', 'many'],
    });
    expect(schema.properties.facts.items.required).toContain('cardinality');
  });

  it('the parser carries one/many and drops any other value', () => {
    const base = { entityIndex: 0, predicate: 'p', valueSpan: 'v', confidence: 0.9 };
    const out = parseRawFacts(
      {
        facts: [
          { ...base, cardinality: 'one' },
          { ...base, cardinality: 'many' },
          { ...base, cardinality: 'single_active' },
          { ...base },
        ],
      },
      1,
    );
    expect(out.map((f) => f.cardinality)).toEqual(['one', 'many', undefined, undefined]);
  });
});

describe('the alias pass hands the registry the reading', () => {
  it('the first fact of a predicate carries it', async () => {
    const facts = [
      {
        entityIndex: 0,
        predicate: 'runs_on',
        object: 'Hetzner',
        confidence: 0.9,
        cardinality: 'one',
      },
      {
        entityIndex: 0,
        predicate: 'runs_on',
        object: 'Fly.io',
        confidence: 0.9,
        cardinality: 'many',
      },
      { entityIndex: 0, predicate: 'attended', object: 'a demo', confidence: 0.9 },
    ] as ExtractedFact[];
    const registry = {
      canonicalize: jest.fn(async (_co: string, predicate: string) => ({
        kind: 'proposed' as const,
        canonicalId: predicate,
        novelPredicateId: predicate,
      })),
    };
    await applyAliasPass({
      facts,
      registry: registry as never,
      companyId: 'co',
      logger: { warn: jest.fn() } as never,
    });
    const byPredicate = new Map(
      registry.canonicalize.mock.calls.map((c) => [c[1], (c as unknown[])[2]]),
    );
    expect(byPredicate.get('runs_on')).toEqual({ text: 'runs_on: Hetzner', cardinality: 'one' });
    expect(byPredicate.get('attended')).toEqual({
      text: 'attended: a demo',
      cardinality: undefined,
    });
  });
});

describe('PredicateRegistryService.canonicalize — who decides a proposed predicate', () => {
  function make(judgeVerdict: 'single_active' | 'append_only' = 'append_only') {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
        if (sql.includes('CREATE knowledge_predicate')) {
          inserted.push(params?.content as Record<string, unknown>);
        }
        return [[]];
      }),
    };
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    };
    const embedder = {
      embed: jest.fn(async () => [1, 0]),
      embedMany: jest.fn(async (t: string[]) => t.map(() => [1, 0])),
    };
    const judge = { classify: jest.fn(async () => judgeVerdict) };
    const svc = new PredicateRegistryService(
      surreal as never,
      embedder as never,
      new ConfigService({ PREDICATE_REGISTRY_CACHE_CAP: '10' }),
      judge as never,
    );
    (svc as unknown as { bootstrapped: { set(k: string, v: true): void } }).bootstrapped.set(
      'co',
      true,
    );
    return { svc, judge, inserted };
  }

  it('"one" registers single_active without asking the judge, and the row says so', async () => {
    const { svc, judge, inserted } = make();
    const d = await svc.canonicalize('co', 'monthly_budget', {
      text: 'monthly_budget: 2500',
      cardinality: 'one',
    });
    expect(d.kind).toBe('proposed');
    expect(judge.classify).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({
      predicateId: 'monthly_budget',
      semantics: 'single_active',
    });
    expect(String(inserted[0]?.description)).toContain('by the extractor');
    // The reading is in effect for the very next write of the slot.
    expect(svc.policyFor('co', 'monthly_budget').semantics).toBe('single_active');
  });

  it('"many" registers append_only without the judge', async () => {
    const { svc, judge, inserted } = make('single_active');
    await svc.canonicalize('co', 'attended_event', {
      text: 'attended_event: a demo',
      cardinality: 'many',
    });
    expect(judge.classify).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ semantics: 'append_only' });
  });

  it('without a reading the judge decides, as before', async () => {
    const { svc, judge, inserted } = make('single_active');
    await svc.canonicalize('co', 'deploy_target', { text: 'deploy_target: Fly.io' });
    expect(judge.classify).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toMatchObject({ semantics: 'single_active' });
    expect(String(inserted[0]?.description)).toContain('by the judge');
  });

  it('a predicate already registered keeps its semantics whatever the reading says', async () => {
    const { svc, judge, inserted } = make();
    await svc.canonicalize('co', 'runs_on', { text: 'runs_on: Fly.io', cardinality: 'one' });
    const again = await svc.canonicalize('co', 'runs_on', {
      text: 'runs_on: Hetzner',
      cardinality: 'many',
    });
    expect(again).toEqual({ kind: 'matched', canonicalId: 'runs_on' });
    expect(inserted).toHaveLength(1);
    expect(judge.classify).not.toHaveBeenCalled();
    expect(svc.policyFor('co', 'runs_on').semantics).toBe('single_active');
  });
});
