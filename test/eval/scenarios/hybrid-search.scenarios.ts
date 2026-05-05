import { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Hybrid-search scenarios — exercise the vector + BM25 fusion path.
 *
 * Two complementary cases:
 *
 *  1. EXACT-TOKEN: a transaction id like "TXN-93847-AC" lives in a fact's
 *     `object`. Embedding-only search routinely under-ranks these — the
 *     token's semantic neighbourhood is empty, so cosine drops it below
 *     paraphrastic noise. BM25 hits it directly via the tokenized index.
 *
 *  2. SEMANTIC: a query like "wants to leave the apartment" should match
 *     a fact `complained_about: "considering moving out"` even though no
 *     surface tokens overlap. BM25 returns nothing here; cosine finds it.
 *
 * Hybrid mode (default) wins both cases — the leg that does have signal
 * surfaces the right entity, and RRF gives it enough rank-position to
 * beat distractors that the other leg may have weakly matched.
 */
export const hybridSearchScenarios: Scenario[] = [
  {
    id: 'hybrid.exact-token-id',
    vertical: 'cross',
    description:
      'Transaction id TXN-93847-AC stored in a `said` fact. Exact-token search must surface it; embedding-only often loses it to paraphrastic distractors.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'cust_alpha' },
        predicate: 'name',
        object: 'Alpha Customer',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'cust_alpha' },
        predicate: 'said',
        object: 'My order TXN-93847-AC was delivered yesterday and the box was damaged.',
        validFrom: ISO('2026-04-15'),
        source: { vertical: 'shop', messageId: 'msg-1' },
      },
      // Distractors — semantically near-but-not the right hit
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'cust_beta' },
        predicate: 'said',
        object: 'My recent purchase arrived in poor condition.',
        validFrom: ISO('2026-04-12'),
        source: { vertical: 'shop', messageId: 'msg-2' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'cust_gamma' },
        predicate: 'said',
        object: 'The packaging was torn when the courier handed it over.',
        validFrom: ISO('2026-04-13'),
        source: { vertical: 'shop', messageId: 'msg-3' },
      },
    ],
    queries: [
      {
        query: 'TXN-93847-AC',
        expectedTopEntityRef: 'shop.cust_alpha',
        expectedFactPredicate: 'said',
      },
    ],
  },
  {
    id: 'hybrid.semantic-paraphrase',
    vertical: 'cross',
    description:
      'Query "thinking of moving out" should match `complained_about: "considering relocation"` via semantic similarity — no shared tokens, vector leg carries the win.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tenant_delta' },
        predicate: 'name',
        object: 'Delta Tenant',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tenant_delta' },
        predicate: 'complained_about',
        object: 'considering relocation to another property',
        validFrom: ISO('2026-04-20'),
        source: { vertical: 'rent', messageId: 'msg-4' },
      },
      // Lexical distractors — share surface tokens with the query but
      // are about a different topic. BM25 alone would over-rank these.
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tenant_eps' },
        predicate: 'said',
        object: 'I am thinking of buying new furniture for the kitchen.',
        validFrom: ISO('2026-04-18'),
        source: { vertical: 'rent', messageId: 'msg-5' },
      },
    ],
    queries: [
      {
        query: 'thinking of moving out',
        expectedTopEntityRef: 'rent.tenant_delta',
        expectedFactPredicate: 'complained_about',
      },
    ],
  },
];
