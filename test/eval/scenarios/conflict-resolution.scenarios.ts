import { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Conflict-resolution scenarios — exercise the predicate-policy
 * machinery (append_only, single_active, bitemporal) and the
 * weighted score system that decides INSERTED vs SUPERSEDED vs
 * COMPETING. Each scenario seeds two-or-more competing facts, then
 * asks a search that depends on the right conflict outcome.
 */
export const conflictResolutionScenarios: Scenario[] = [
  {
    id: 'conflict.single_active-name-wins-by-recency',
    vertical: 'estate',
    description:
      'Property listing name updated; latest name supersedes previous. Search by old name should still find the property (alias-fallback) but the canonical name on profile is the new one.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'listing_renaming' },
        predicate: 'name',
        object: 'Sunset Loft 2BR',
        validFrom: ISO('2026-03-01'),
        source: { vertical: 'estate', eventId: 'auth.listing_create' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'listing_renaming' },
        predicate: 'name',
        object: 'Sunset Loft Premium',
        validFrom: ISO('2026-05-01'),
        source: { vertical: 'estate', eventId: 'auth.listing_renamed' },
      },
    ],
    queries: [
      {
        query: 'Sunset Loft Premium',
        expectedTopEntityRef: 'estate.listing_renaming',
        expectedFactPredicate: 'name',
      },
    ],
  },
  {
    id: 'conflict.bitemporal-tier-competing-not-supersede',
    vertical: 'rent',
    description:
      'Two tier facts with similar weight but disagreeing values arrive close together. Neither should supersede; both are active under `competing` status until external resolution.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_competing_cust' },
        predicate: 'name',
        object: 'Sasha Volkov',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_competing_cust' },
        predicate: 'tier',
        object: 'gold',
        confidence: 0.7,
        validFrom: ISO('2026-05-01'),
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_competing_cust' },
        predicate: 'tier',
        object: 'silver',
        confidence: 0.7,
        validFrom: ISO('2026-05-02'),
        source: { vertical: 'rent', eventId: 'billing.tier_change' },
      },
    ],
    queries: [
      {
        query: 'Sasha Volkov tier',
        expectedTopEntityRef: 'rent.tier_competing_cust',
        expectedFactPredicate: 'tier',
      },
    ],
  },
  {
    id: 'conflict.append_only-said-no-supersede',
    vertical: 'shop',
    description:
      'Customer makes two distinct utterances. Both must remain active; append_only never supersedes.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'append_test_cust' },
        predicate: 'name',
        object: 'Olga Petrov',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'append_test_cust' },
        predicate: 'said',
        object: 'I love the new packaging design',
        validFrom: ISO('2026-04-10'),
        source: { vertical: 'shop', messageId: 'm_a' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'append_test_cust' },
        predicate: 'said',
        object: 'My delivery arrived two days late though',
        validFrom: ISO('2026-04-12'),
        source: { vertical: 'shop', messageId: 'm_b' },
      },
    ],
    queries: [
      {
        query: 'who liked the packaging',
        expectedTopEntityRef: 'shop.append_test_cust',
        expectedFactPredicate: 'said',
      },
      {
        query: 'whose delivery was late',
        expectedTopEntityRef: 'shop.append_test_cust',
        expectedFactPredicate: 'said',
      },
    ],
  },
];
