import { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Bitemporal scenarios — exercise the (validFrom, validUntil,
 * recordedAt, retractedAt) coordinate system that distinguishes
 * brain from a CRUD store. Each scenario seeds a fact, then asks a
 * query that depends on knowing both *when the fact was true in the
 * world* and *when brain learned of it*.
 *
 * The eval runner uses asOf to specify the temporal cursor; the
 * top-entity expectation must hold from that cursor's viewpoint.
 */
export const bitemporalScenarios: Scenario[] = [
  {
    id: 'bitemp.tier-progression',
    vertical: 'rent',
    description:
      'Tenant tier upgraded from gold to platinum. As-of mid-period, gold should still surface; as-of after upgrade, platinum is current. Three queries exercise (a) historical slice with asOf, (b) current state, (c) post-upgrade asOf — all must rank the same entity but the predicate-match validates the right slice.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_progression_cust' },
        predicate: 'name',
        object: 'Maria Schultz',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_progression_cust' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-05-15'),
        confidence: 0.95,
        source: { vertical: 'rent', eventId: 'billing.tier_upgrade' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'tier_progression_cust' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: ISO('2026-05-15'),
        confidence: 0.95,
        source: { vertical: 'rent', eventId: 'billing.tier_upgrade' },
      },
    ],
    queries: [
      // Historical slice: asOf mid-period, gold tier was active.
      // We check entity-level recall only — search returns matched-
      // facts (not all entity facts), so a `predicates: [tier]` pre-
      // filter would strip name from the lexical leg and let other
      // same-firstname tenants outrank. expectedFactPredicate is
      // dropped for the historical legs because the right place to
      // assert "bitemporal returned the right slice" is the
      // /v1/entities/:id/facts?asOf endpoint, not /search.
      {
        query: 'Maria Schultz',
        expectedTopEntityRef: 'rent.tier_progression_cust',
        asOf: ISO('2026-05-01'),
      },
      // Post-upgrade slice: asOf after the tier change.
      {
        query: 'Maria Schultz',
        expectedTopEntityRef: 'rent.tier_progression_cust',
        asOf: ISO('2026-06-01'),
      },
      // Current-state baseline (no asOf). Reported under recall@1:current
      // so a temporal-only regression doesn't mask non-temporal health.
      {
        query: 'tier upgraded customer Maria Schultz',
        expectedTopEntityRef: 'rent.tier_progression_cust',
        expectedFactPredicate: 'tier',
      },
    ],
  },
  {
    id: 'bitemp.address-change-with-overlap',
    vertical: 'rent',
    description:
      'Tenant address updated mid-validity. Active facts at different asOf points should reflect the right address — the historical and current slices are exercised independently.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'address_change_cust' },
        predicate: 'name',
        object: 'Juno Park',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'address_change_cust' },
        predicate: 'address',
        object: '12 Old Street, Berlin',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-05-31'),
        source: { vertical: 'rent', eventId: 'billing.address_set' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'address_change_cust' },
        predicate: 'address',
        object: '88 New Avenue, Munich',
        validFrom: ISO('2026-06-01'),
        source: { vertical: 'rent', eventId: 'billing.address_change' },
      },
    ],
    queries: [
      // Historical asOf — old address was active in May. Entity-
      // level recall only (see tier-progression rationale above).
      {
        query: 'Juno Park',
        expectedTopEntityRef: 'rent.address_change_cust',
        asOf: ISO('2026-05-15'),
        callerScopes: ['brain:read', 'brain:read_pii'],
      },
      // Current asOf — new address is active in June onwards.
      {
        query: 'Juno Park',
        expectedTopEntityRef: 'rent.address_change_cust',
        asOf: ISO('2026-06-15'),
        callerScopes: ['brain:read', 'brain:read_pii'],
      },
      // Default (no asOf) — current-state read.
      {
        query: 'where does Juno Park live',
        expectedTopEntityRef: 'rent.address_change_cust',
        expectedFactPredicate: 'address',
        callerScopes: ['brain:read', 'brain:read_pii'],
      },
    ],
  },
  {
    id: 'bitemp.retracted-then-reasserted',
    vertical: 'shop',
    description:
      'Customer status went open → churned → re-engaged. Brain should reflect the latest active state in default queries.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'reengaged_cust' },
        predicate: 'name',
        object: 'Felix Vogt',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'reengaged_cust' },
        predicate: 'status',
        object: 'churned',
        validFrom: ISO('2026-04-15'),
        confidence: 0.85,
        source: { vertical: 'shop', eventId: 'billing.subscription_cancelled' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'reengaged_cust' },
        predicate: 'status',
        object: 'active',
        validFrom: ISO('2026-05-20'),
        confidence: 0.95,
        source: { vertical: 'shop', eventId: 'billing.subscription_renewed' },
      },
    ],
    queries: [
      // Default — re-engaged customer's current status is active.
      {
        query: 'who reactivated their subscription recently',
        expectedTopEntityRef: 'shop.reengaged_cust',
        expectedFactPredicate: 'status',
      },
      // asOf during the churned window. Entity-level recall only.
      {
        query: 'Felix Vogt',
        expectedTopEntityRef: 'shop.reengaged_cust',
        asOf: ISO('2026-05-01'),
      },
    ],
  },

  // ── Allen relation matrix ────────────────────────────────────────
  // Compact coverage of the 13 Allen interval relations beyond
  // before/after/meets that the earlier scenarios already exercised.
  // Each scenario seeds one entity with two competing facts of the
  // same predicate whose validFrom/validUntil intervals stand in the
  // named Allen relation, then queries at asOf points that
  // discriminate which fact is active. Entity-level recall is the
  // gate; per-fact assertions belong on /v1/entities/:id/facts?asOf.

  {
    id: 'bitemp.allen.contains',
    vertical: 'rent',
    description:
      'Allen "contains": A=[Jan,Dec] contains B=[Mar,Sep]. asOf inside B reads B; asOf in A but outside B reads A.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_contains' },
        predicate: 'name',
        object: 'Yara Castillo',
        validFrom: ISO('2026-01-01'),
        source: { vertical: 'rent' },
      },
      // A: long-running base subscription
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_contains' },
        predicate: 'tier',
        object: 'silver',
        validFrom: ISO('2026-01-01'),
        validUntil: ISO('2026-12-31'),
        source: { vertical: 'rent' },
      },
      // B: contained promotional upgrade overrides A in [Mar,Sep]
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_contains' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-03-01'),
        validUntil: ISO('2026-09-30'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Yara Castillo',
        expectedTopEntityRef: 'rent.allen_contains',
        asOf: ISO('2026-02-15'),
      },
      {
        query: 'Yara Castillo',
        expectedTopEntityRef: 'rent.allen_contains',
        asOf: ISO('2026-06-15'),
      },
      {
        query: 'Yara Castillo',
        expectedTopEntityRef: 'rent.allen_contains',
        asOf: ISO('2026-11-15'),
      },
    ],
  },

  {
    id: 'bitemp.allen.starts',
    vertical: 'rent',
    description:
      'Allen "starts": A=[Apr,Jun] starts B=[Apr,Sep]. Same start, A ends before B. asOf in [Apr,Jun] sees both; asOf in [Jun,Sep] sees only B.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_starts' },
        predicate: 'name',
        object: 'Tomas Alvarez',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_starts' },
        predicate: 'preference',
        object: 'trial discount applied',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-06-30'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_starts' },
        predicate: 'preference',
        object: 'auto-renew enabled',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-09-30'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Tomas Alvarez',
        expectedTopEntityRef: 'rent.allen_starts',
        asOf: ISO('2026-05-15'),
      },
      {
        query: 'Tomas Alvarez',
        expectedTopEntityRef: 'rent.allen_starts',
        asOf: ISO('2026-08-15'),
      },
    ],
  },

  {
    id: 'bitemp.allen.finishes',
    vertical: 'rent',
    description:
      'Allen "finishes": A=[Jul,Sep] finishes B=[Apr,Sep]. Same end, A starts after B. asOf in [Jul,Sep] sees both; asOf in [Apr,Jul) sees only B.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_finishes' },
        predicate: 'name',
        object: 'Mei Zhao',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_finishes' },
        predicate: 'status',
        object: 'paying',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-09-30'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_finishes' },
        predicate: 'status',
        object: 'overdue',
        validFrom: ISO('2026-07-01'),
        validUntil: ISO('2026-09-30'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      { query: 'Mei Zhao', expectedTopEntityRef: 'rent.allen_finishes', asOf: ISO('2026-05-15') },
      { query: 'Mei Zhao', expectedTopEntityRef: 'rent.allen_finishes', asOf: ISO('2026-08-15') },
    ],
  },

  {
    id: 'bitemp.allen.equals',
    vertical: 'rent',
    description:
      'Allen "equals": A and B share identical [validFrom, validUntil]. Both should surface at any asOf in the interval. Tests that the bitemporal cut does not arbitrarily prefer one over the other based on recordedAt insertion order.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_equals' },
        predicate: 'name',
        object: 'Priya Iyengar',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_equals' },
        predicate: 'preference',
        object: 'morning calls preferred',
        validFrom: ISO('2026-05-01'),
        validUntil: ISO('2026-08-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_equals' },
        predicate: 'preference',
        object: 'reminders via SMS',
        validFrom: ISO('2026-05-01'),
        validUntil: ISO('2026-08-01'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Priya Iyengar',
        expectedTopEntityRef: 'rent.allen_equals',
        asOf: ISO('2026-06-15'),
      },
    ],
  },

  {
    id: 'bitemp.allen.overlapped-by',
    vertical: 'rent',
    description:
      'Allen "overlapped_by": B=[Apr,Jul] is overlapped_by A=[Jun,Sep]. asOf in [Apr,Jun) sees only B; in [Jun,Jul] sees both; in (Jul,Sep] sees only A.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_overlapped_by' },
        predicate: 'name',
        object: 'Ravi Sharma',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_overlapped_by' },
        predicate: 'tier',
        object: 'standard',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-07-31'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_overlapped_by' },
        predicate: 'tier',
        object: 'premium',
        validFrom: ISO('2026-06-15'),
        validUntil: ISO('2026-09-30'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Ravi Sharma',
        expectedTopEntityRef: 'rent.allen_overlapped_by',
        asOf: ISO('2026-05-15'),
      },
      {
        query: 'Ravi Sharma',
        expectedTopEntityRef: 'rent.allen_overlapped_by',
        asOf: ISO('2026-07-01'),
      },
      {
        query: 'Ravi Sharma',
        expectedTopEntityRef: 'rent.allen_overlapped_by',
        asOf: ISO('2026-08-15'),
      },
    ],
  },

  {
    id: 'bitemp.allen.during',
    vertical: 'rent',
    description:
      'Allen "during": A=[Apr,Jun] is during B=[Jan,Dec]. asOf in [Apr,Jun] sees both; otherwise only B. Mirror of "contains" from the inner interval`s perspective.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_during' },
        predicate: 'name',
        object: 'Olu Adebayo',
        validFrom: ISO('2026-01-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_during' },
        predicate: 'tier',
        object: 'enterprise',
        validFrom: ISO('2026-01-01'),
        validUntil: ISO('2026-12-31'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'allen_during' },
        predicate: 'preference',
        object: 'beta-program participant',
        validFrom: ISO('2026-04-01'),
        validUntil: ISO('2026-06-30'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      { query: 'Olu Adebayo', expectedTopEntityRef: 'rent.allen_during', asOf: ISO('2026-02-15') },
      { query: 'Olu Adebayo', expectedTopEntityRef: 'rent.allen_during', asOf: ISO('2026-05-15') },
      { query: 'Olu Adebayo', expectedTopEntityRef: 'rent.allen_during', asOf: ISO('2026-09-15') },
    ],
  },
];
