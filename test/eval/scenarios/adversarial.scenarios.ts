/**
 * Adversarial + temporal + bulk-load scenarios. Exercises brain on the
 * cases that thin per-vertical happy-path scenarios miss:
 *
 *   - **Typos / OCR-style noise** — `Anna Schmdit`, `Bjorn Madson`,
 *     transposed letters in the query side. The embedding leg should
 *     recover here even when BM25 can't.
 *   - **Multilingual** — same person named in Cyrillic vs Latin script;
 *     entity profile should still resolve via canonicalName + aliases.
 *   - **Temporal** — bitemporal queries with `asOf` predating a fact.
 *     The runner already supports `asOf`; this exercises it.
 *   - **Bulk** — one customer accumulates many facts. Must not get
 *     drowned by their own volume in unrelated queries (search relevance
 *     should still discriminate by predicate semantics).
 *   - **Disambiguation** — two entities with the same first name; query
 *     should pick the right one based on predicate-bearing context.
 */

import type { Scenario, SetupStep } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

// 30 facts of varied predicates seeded under one customer for the bulk
// scenario — enough to crowd the embedding space, small enough to keep
// the suite fast.
function bulkFactsFor(
  vertical: string,
  id: string,
  startDate: string,
): SetupStep[] {
  const predicates = [
    'tier',
    'preferred_contact_channel',
    'language',
    'timezone',
    'opt_in_marketing',
    'lifetime_orders',
    'avg_order_value',
    'last_login_channel',
    'support_ticket_count',
    'preferred_payment_method',
  ];
  const objects = [
    'gold',
    'email',
    'en-GB',
    'Europe/Berlin',
    'true',
    '17',
    '€428',
    'web',
    '3',
    'sepa',
  ];
  const day = new Date(startDate).getTime();
  return predicates.flatMap<SetupStep>((p, i) => [
    {
      kind: 'fact',
      entityRef: { vertical, id },
      predicate: p,
      object: objects[i],
      validFrom: new Date(day + i * 86_400_000).toISOString(),
      confidence: 0.85,
      source: { vertical, eventId: `bulk.seed.${i}` },
    },
    {
      kind: 'fact',
      entityRef: { vertical, id },
      predicate: p,
      object: `${objects[i]}_v2`,
      validFrom: new Date(day + (i + 14) * 86_400_000).toISOString(),
      confidence: 0.85,
      source: { vertical, eventId: `bulk.seed.update.${i}` },
    },
    {
      kind: 'fact',
      entityRef: { vertical, id },
      predicate: 'note',
      object: `${p} change recorded`,
      validFrom: new Date(day + (i + 7) * 86_400_000).toISOString(),
      source: { vertical, eventId: `bulk.note.${i}` },
    },
  ]);
}

export const adversarialScenarios: Scenario[] = [
  // ── 1. Typo-tolerant retrieval (rent) ───────────────────────────────
  {
    id: 'rent.adversarial.typo-name',
    vertical: 'rent',
    description:
      'Operator searches with a misspelled tenant name ("Anna Schmdit"). Embedding leg should still resolve to Anna Schmidt.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'anna' },
        predicate: 'name',
        object: 'Anna Schmidt',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'anna' },
        predicate: 'complained_about',
        object: 'broken intercom',
        validFrom: ISO('2026-04-22'),
        source: { vertical: 'rent', messageId: 'msg_anna_intercom' },
      },
      // Distractor with similar-shaped name
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'hannah' },
        predicate: 'name',
        object: 'Hannah Schultz',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Anna Schmdit complaint',
        expectedTopEntityRef: 'rent.anna',
      },
      {
        query: 'tenant who reported broken intercom',
        expectedTopEntityRef: 'rent.anna',
        expectedFactPredicate: 'complained_about',
      },
    ],
  },

  // ── 2. Multilingual / cross-script disambiguation (estate) ──────────
  {
    id: 'estate.adversarial.multilingual',
    vertical: 'estate',
    description:
      'Same lead known by Cyrillic and Latin name forms. Operator searches by either; brain must converge to one entity.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'anya' },
        predicate: 'name',
        object: 'Anya Volkov',
        validFrom: ISO('2026-04-10'),
        confidence: 0.95,
        source: { vertical: 'estate' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'anya' },
        predicate: 'alias',
        object: 'Аня Волкова',
        validFrom: ISO('2026-04-10'),
        confidence: 0.9,
        source: { vertical: 'estate' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'anya' },
        predicate: 'interacted_with',
        object: 'submitted offer: 540k for unit 7C',
        validFrom: ISO('2026-04-29'),
        source: { vertical: 'estate', eventId: 'storefront.offer.submitted' },
      },
      // Distractor with similar Latin shape but distinct
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'andrey' },
        predicate: 'name',
        object: 'Andrey Volkov',
        validFrom: ISO('2026-04-10'),
        source: { vertical: 'estate' },
      },
    ],
    queries: [
      {
        query: 'Аня Волкова заявка на квартиру',
        expectedTopEntityRef: 'estate.anya',
      },
      {
        query: 'who submitted the 540k offer for unit 7C',
        expectedTopEntityRef: 'estate.anya',
      },
    ],
  },

  // ── 3. Temporal: asOf predates a retraction (rent) ──────────────────
  {
    id: 'rent.adversarial.temporal-asof',
    vertical: 'rent',
    description:
      'Tenant changes tier from gold to platinum mid-cycle. Query asOf=2026-03-01 should still rank the gold-tier customer profile, not the platinum one.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'mira' },
        predicate: 'name',
        object: 'Mira Okafor',
        validFrom: ISO('2026-01-15'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'mira' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-01-15'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'mira' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: ISO('2026-04-15'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'Mira Okafor tier history',
        expectedTopEntityRef: 'rent.mira',
        asOf: ISO('2026-03-01'),
      },
      {
        query: 'Mira Okafor current plan',
        expectedTopEntityRef: 'rent.mira',
        // No asOf → should rank Mira at the latest tier
      },
    ],
  },

  // ── 4. Bulk: one customer with 30+ noisy facts (shop) ───────────────
  {
    id: 'shop.adversarial.bulk-customer',
    vertical: 'shop',
    description:
      'Heavy customer with 30+ profile facts plus a single distinctive complaint. Search by complaint text should still surface them despite the noise.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit' },
        predicate: 'name',
        object: 'Rohit Mehta',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: 'shop' },
      },
      ...bulkFactsFor('shop', 'rohit', '2026-01-01'),
      // Single distinctive event we want to find
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit' },
        predicate: 'complained_about',
        object: 'wireless headphones charging case rattles',
        validFrom: ISO('2026-04-25'),
        source: { vertical: 'shop', messageId: 'msg_rohit_hp' },
      },
      // Distractor with overlapping profile fields
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'priya' },
        predicate: 'name',
        object: 'Priya Sharma',
        validFrom: ISO('2026-01-01'),
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'priya' },
        predicate: 'lifetime_orders',
        object: '17',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'shop' },
      },
    ],
    queries: [
      {
        query: 'rattling charging case complaint',
        expectedTopEntityRef: 'shop.rohit',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'customers reporting headphones issues',
        expectedTopEntityRef: 'shop.rohit',
      },
    ],
  },

  // ── 5. Same-name disambiguation (events) ────────────────────────────
  {
    id: 'events.adversarial.shared-firstname',
    vertical: 'events',
    description:
      'Two attendees both named "Maria" with different surnames; one had a seating issue, one a dietary concern. Predicate-aware queries must pick the right Maria.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'maria_v' },
        predicate: 'name',
        object: 'Maria Velasquez',
        validFrom: ISO('2026-04-15'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'maria_v' },
        predicate: 'complained_about',
        object: 'seating in section C — partial stage view',
        validFrom: ISO('2026-04-29'),
        source: { vertical: 'events', messageId: 'msg_maria_v_seat' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'maria_t' },
        predicate: 'name',
        object: 'Maria Tanaka',
        validFrom: ISO('2026-04-15'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'maria_t' },
        predicate: 'requested',
        object: 'gluten-free meal substitution',
        validFrom: ISO('2026-04-29'),
        source: { vertical: 'events', messageId: 'msg_maria_t_diet' },
      },
    ],
    queries: [
      {
        query: 'attendee with partial-view seat complaint',
        expectedTopEntityRef: 'events.maria_v',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'attendee who needs gluten-free meal',
        expectedTopEntityRef: 'events.maria_t',
        expectedFactPredicate: 'requested',
      },
    ],
  },

  // ── 6. PII gating under noise (health) ──────────────────────────────
  {
    id: 'health.adversarial.pii-with-distractor',
    vertical: 'health',
    description:
      'Patient profile carries DOB (PII). Search by symptom must surface the patient, but a limited-scope caller must NOT see DOB.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_88' },
        predicate: 'name',
        object: 'patient_88',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_88' },
        predicate: 'dob',
        object: '1981-07-12',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_88' },
        predicate: 'reported_symptom',
        object: 'persistent dry cough for 3 weeks',
        validFrom: ISO('2026-04-28'),
        source: { vertical: 'health', messageId: 'msg_patient_88_cough' },
      },
      // Distractor patient
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_99' },
        predicate: 'name',
        object: 'patient_99',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_99' },
        predicate: 'reported_symptom',
        object: 'mild seasonal allergies',
        validFrom: ISO('2026-04-25'),
        source: { vertical: 'health' },
      },
    ],
    queries: [
      {
        query: 'patient with persistent dry cough',
        expectedTopEntityRef: 'health.patient_88',
        expectedFactPredicate: 'reported_symptom',
      },
      {
        query: 'patient with persistent dry cough',
        expectedTopEntityRef: 'health.patient_88',
        callerScopes: ['brain:read'],
        mustNotLeakPredicate: 'dob',
      },
    ],
  },

  // ── 7. Cross-vertical identity (rent ↔ events) ──────────────────────
  {
    id: 'cross.adversarial.identity-merge',
    vertical: 'cross',
    description:
      'Same person known in both rent (tenant) and events (attendee) verticals. After identity_of link, profile lookup by either vertical resolves to the merged entity with both vertical-tagged externalRefs.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'jonas' },
        predicate: 'name',
        object: 'Jonas Berg',
        validFrom: ISO('2026-03-01'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'jonas' },
        predicate: 'complained_about',
        object: 'late-night noise from upstairs',
        validFrom: ISO('2026-04-20'),
        source: { vertical: 'rent', messageId: 'msg_jonas_noise' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'jonas' },
        predicate: 'name',
        object: 'Jonas Berg',
        validFrom: ISO('2026-04-15'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'jonas' },
        predicate: 'interacted_with',
        object: 'attended VIP suite at jazz night',
        validFrom: ISO('2026-04-22'),
        source: { vertical: 'events', eventId: 'storefront.attendance' },
      },
      {
        kind: 'link',
        from: { vertical: 'rent', id: 'jonas' },
        to: { vertical: 'events', id: 'jonas' },
        linkKind: 'identity_of',
        source: { vertical: 'rent', eventId: 'identity.merge' },
      },
    ],
    queries: [
      {
        query: 'Jonas Berg complaint about noise',
        expectedTopEntityRef: 'rent.jonas',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'Jonas Berg attended any events',
        expectedTopEntityRef: 'events.jonas',
      },
    ],
    identityMerge: {
      survivorRef: 'rent.jonas',
      loserRef: 'events.jonas',
    },
  },
];
