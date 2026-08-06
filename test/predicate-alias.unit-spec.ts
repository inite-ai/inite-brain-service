import { ExtractorRefineService } from '../src/ai/extractor-refine.service';
import { applyAliasPass } from '../src/ai/extractor-internals/predicate-canonicalize';
import type { ExtractedFact } from '../src/ai/extractor-internals/types';
import { DEFAULT_FALLBACK } from '../src/ai/predicate-registry-internals/types';
import { DEFAULT_POLICY } from '../src/ingest/conflict-resolver';
import { FactResolverService } from '../src/ingest/fact-resolver.service';

/**
 * W3 (0082): coined-predicate canonicalization into predicateAlias +
 * append_only default for open (unknown) predicates. The raw coinage
 * must SURVIVE in `predicate`; the EDC-canonical id rides in
 * `predicateAlias`; the resolver threads it into fn::resolve_fact as
 * the 24th positional arg.
 */
describe('predicate alias (W3 0082)', () => {
  const fact = (predicate: string, over: Partial<ExtractedFact> = {}): ExtractedFact => ({
    entityIndex: 0,
    predicate,
    object: 'painted a sunset over the bay',
    confidence: 0.9,
    clause: 'She painted a sunset over the bay',
    ...over,
  });
  const logger = { warn: jest.fn() } as never;

  describe('applyAliasPass', () => {
    it('stamps the canonical id into predicateAlias and keeps the coinage', async () => {
      const facts = [fact('painted_seascape')];
      const registry = {
        canonicalize: jest.fn(async () => ({
          kind: 'aliased' as const,
          canonicalId: 'painted',
          similarity: 0.91,
          novelPredicateId: 'painted_seascape',
        })),
      };
      const decisions = await applyAliasPass({
        facts,
        registry: registry as never,
        companyId: 'co_x',
        logger,
      });
      expect(facts[0].predicate).toBe('painted_seascape');
      expect(facts[0].predicateAlias).toBe('painted');
      expect(decisions).toEqual([
        {
          original: 'painted_seascape',
          canonical: 'painted',
          kind: 'aliased',
          similarity: 0.91,
        },
      ]);
    });

    it('a predicate that is its own canon gets NO alias', async () => {
      const facts = [fact('painted')];
      const registry = {
        canonicalize: jest.fn(async () => ({
          kind: 'proposed' as const,
          canonicalId: 'painted',
          novelPredicateId: 'painted',
        })),
      };
      const decisions = await applyAliasPass({
        facts,
        registry: registry as never,
        companyId: 'co_x',
        logger,
      });
      expect(facts[0].predicateAlias).toBeUndefined();
      expect(decisions).toEqual([]);
    });

    it('a registry error leaves the fact aliasless and does not throw', async () => {
      const facts = [fact('painted_seascape')];
      const registry = {
        canonicalize: jest.fn(async () => {
          throw new Error('registry down');
        }),
      };
      await applyAliasPass({
        facts,
        registry: registry as never,
        companyId: 'co_x',
        logger,
      });
      expect(facts[0].predicateAlias).toBeUndefined();
      expect(facts[0].predicate).toBe('painted_seascape');
    });
  });

  describe('ExtractorRefineService (open vocabulary)', () => {
    const OLD = process.env.EXTRACTOR_DIALOGUE_PROFILE;
    afterEach(() => {
      if (OLD === undefined) delete process.env.EXTRACTOR_DIALOGUE_PROFILE;
      else process.env.EXTRACTOR_DIALOGUE_PROFILE = OLD;
    });

    it('runs the alias pass and skips both overwrite passes', async () => {
      process.env.EXTRACTOR_DIALOGUE_PROFILE = '1';
      const registry = {
        canonicalize: jest.fn(async () => ({
          kind: 'aliased' as const,
          canonicalId: 'painted',
          similarity: 0.9,
          novelPredicateId: 'painted_seascape',
        })),
      };
      const localPredicates = { rank: jest.fn() };
      const svc = new ExtractorRefineService(
        registry as never,
        localPredicates as never,
      );
      const facts = [fact('painted_seascape')];
      await svc.applyPredicateRefinements(facts, null as never, 'co_x');
      // Coinage kept, alias stamped, no local-override ranking ran.
      expect(facts[0].predicate).toBe('painted_seascape');
      expect(facts[0].predicateAlias).toBe('painted');
      expect(localPredicates.rank).not.toHaveBeenCalled();
      expect(registry.canonicalize).toHaveBeenCalledTimes(1);
    });
  });

  describe('append_only default for open predicates', () => {
    it('the unknown-predicate fallback is append_only on both lookups', () => {
      expect(DEFAULT_FALLBACK.semantics).toBe('append_only');
      expect(DEFAULT_POLICY.semantics).toBe('append_only');
    });
  });

  describe('FactResolverService threading', () => {
    function make() {
      const queries: Array<{ sql: string; params: any }> = [];
      const db = {
        query: jest.fn(async (sql: string, params: any) => {
          queries.push({ sql, params });
          if (sql.includes('fn::resolve_facts')) {
            return [
              params.facts.map(() => ({
                factId: 'knowledge_fact:b',
                outcome: 'INSERTED',
              })),
            ];
          }
          return [{ factId: 'knowledge_fact:s', outcome: 'INSERTED' }];
        }),
      };
      const svc = new FactResolverService(
        {
          embed: jest.fn(async () => [0.1]),
          writeAltEmbeddingIfHype: jest.fn(async () => {}),
        } as never,
        {
          getSnapshot: jest.fn(async () => ({})),
          policyFor: jest.fn((_c: string, p: string) => ({
            semantics: p === 'status' ? 'single_active' : 'append_only',
          })),
        } as never,
      );
      return { svc, db, queries };
    }
    const input = (predicate: string, predicateAlias?: string) => ({
      companyId: 'co_x',
      entityId: 'knowledge_entity:e1',
      predicate,
      predicateAlias,
      object: 'gold',
      confidence: 0.9,
      validFrom: new Date('2023-01-01T00:00:00Z'),
      source: {},
      precomputedEmbedding: [0.1],
    });

    it('per-fact path binds $predicate_alias as the 24th arg', async () => {
      const { svc, db, queries } = make();
      await svc.resolve(db as never, input('status', 'state'));
      const q = queries.find((x) => x.sql.includes('fn::resolve_fact('));
      expect(q!.sql).toContain('$predicate_alias');
      expect(q!.params.predicate_alias).toBe('state');
      expect(q!.params.predicate).toBe('status');
    });

    it('batched append_only path carries predicate_alias per fact, omitted when absent', async () => {
      const { svc, db, queries } = make();
      await svc.resolveMany(db as never, [
        input('painted_seascape', 'painted'),
        input('researched'),
      ]);
      const batch = queries.find((x) => x.sql.includes('fn::resolve_facts'));
      expect(batch!.params.facts[0].predicate_alias).toBe('painted');
      expect(batch!.params.facts[0].predicate).toBe('painted_seascape');
      expect('predicate_alias' in batch!.params.facts[1]).toBe(false);
    });
  });
});
