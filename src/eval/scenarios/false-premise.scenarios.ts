/**
 * False-premise / hallucination-resistance scenarios (Synthius-Mem's
 * "adversarial robustness"). Each scenario seeds a small, TRUE corpus, then
 * asks a question whose PREMISE the corpus never supported — an invented
 * relative, an invented job, an event that never happened, or a fact
 * mis-attributed across two same-named people. The load-bearing safety
 * property of a memory system is that it REFUSES these rather than
 * fabricating a plausible answer, so each false-premise query is marked
 * `expectRefusal` and passes IFF the synthesizer declines.
 *
 * Every scenario also ships a CONTROL query — a well-grounded question the
 * system MUST answer (normal faithfulnessFloor). The control is the guard
 * against a degenerate "refuse everything" system: it would pass all the
 * expectRefusal gates but fail its controls, so the pair together measures
 * refusal WITHOUT over-refusal.
 *
 * Setup uses deterministic `kind: 'fact'` steps (no extraction LLM cost).
 * Verticals are drawn from the existing `Vertical` union so the per-vertical
 * report has no unmatched slice.
 */

import type { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

export const falsePremiseScenarios: Scenario[] = [
  {
    id: 'rent.false-premise.invented-relative',
    vertical: 'rent',
    description:
      "Anna complained about the intercom; ask about her (never-mentioned) brother. Must refuse.",
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
        object: 'broken intercom at the main entrance',
        validFrom: ISO('2026-04-05'),
        confidence: 0.9,
        source: { vertical: 'rent' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      {
        query: "What did Anna Schmidt's brother say about the intercom?",
        expectRefusal: true,
      },
      // Control — grounded; the system must NOT refuse this one.
      { query: 'What did Anna Schmidt complain about?', faithfulnessFloor: 0.85 },
    ],
  },
  {
    id: 'shop.false-premise.invented-job',
    vertical: 'shop',
    description:
      'Rohit has a profile but no employer facts; ask when he worked at Google. Must refuse.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit' },
        predicate: 'name',
        object: 'Rohit Mehta',
        validFrom: ISO('2026-03-10'),
        confidence: 0.95,
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit' },
        predicate: 'preference',
        object: 'noise-cancelling headphones',
        validFrom: ISO('2026-03-12'),
        confidence: 0.85,
        source: { vertical: 'shop' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      { query: 'When did Rohit Mehta work at Google?', expectRefusal: true },
      { query: 'What product does Rohit Mehta prefer?', faithfulnessFloor: 0.85 },
    ],
  },
  {
    id: 'events.false-premise.invented-event',
    vertical: 'events',
    description:
      'Maria Velasquez complained about seating; ask about her (never-mentioned) wedding. Must refuse.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'velasquez' },
        predicate: 'name',
        object: 'Maria Velasquez',
        validFrom: ISO('2026-02-01'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'velasquez' },
        predicate: 'complained_about',
        object: 'poor seating allocation at the gala',
        validFrom: ISO('2026-02-03'),
        confidence: 0.9,
        source: { vertical: 'events' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      {
        query: "How was Maria Velasquez's wedding reception?",
        expectRefusal: true,
      },
      {
        query: 'What did Maria Velasquez complain about at the gala?',
        faithfulnessFloor: 0.85,
      },
    ],
  },
  {
    id: 'events.false-premise.cross-entity-attribution',
    vertical: 'events',
    description:
      'Two Marias: Velasquez complained about seating, Tanaka did not. Ask about Tanaka. Must refuse. Retrieval WILL return strong same-firstname hits — only the verifier saves it.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'velasquez' },
        predicate: 'name',
        object: 'Maria Velasquez',
        validFrom: ISO('2026-02-01'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'velasquez' },
        predicate: 'complained_about',
        object: 'poor seating allocation at the gala',
        validFrom: ISO('2026-02-03'),
        confidence: 0.9,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'tanaka' },
        predicate: 'name',
        object: 'Maria Tanaka',
        validFrom: ISO('2026-02-01'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'tanaka' },
        predicate: 'interacted_with',
        object: 'checked in at the registration desk',
        validFrom: ISO('2026-02-02'),
        confidence: 0.9,
        source: { vertical: 'events' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      {
        query: 'When did Maria Tanaka complain about the seating?',
        expectRefusal: true,
      },
      // Control — the complaint really is Velasquez's.
      {
        query: 'Who complained about the seating at the gala?',
        faithfulnessFloor: 0.85,
      },
    ],
  },
  {
    id: 'health.false-premise.invented-condition',
    vertical: 'health',
    description:
      'patient_88 reported a migraine; ask about diabetes medication (never mentioned). Must refuse.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_88' },
        predicate: 'name',
        object: 'Diego Fuentes',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_88' },
        predicate: 'reported_symptom',
        object: 'persistent migraine with aura',
        validFrom: ISO('2026-04-03'),
        confidence: 0.9,
        source: { vertical: 'health' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      {
        query: 'What medication was patient_88 prescribed for diabetes?',
        expectRefusal: true,
      },
      {
        query: 'What symptom did Diego Fuentes report?',
        faithfulnessFloor: 0.85,
      },
    ],
    // Retrieval-contamination guard: a "diabetes" query must not surface a
    // fact about this patient — there is none. (Absence assertion on search.)
    memoryAssertions: [
      {
        description: 'no diabetes fact surfaces for patient_88',
        kind: 'search_object_absent',
        query: 'patient_88 diabetes',
        expectedRefAbsent: 'health.patient_88',
        objectSubstring: 'diabetes',
      },
    ],
  },
  {
    id: 'estate.false-premise.temporal',
    vertical: 'estate',
    description:
      'Anya submitted an offer on 2026-04-29; ask as-of 2026-03-01 (before it existed). Must refuse.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'anya' },
        predicate: 'name',
        object: 'Anya Kovac',
        validFrom: ISO('2026-03-01'),
        confidence: 0.95,
        source: { vertical: 'estate' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'estate', id: 'anya' },
        predicate: 'interacted_with',
        object: 'submitted an offer of €710k on 14 Birch Lane',
        validFrom: ISO('2026-04-29'),
        confidence: 0.9,
        source: { vertical: 'estate', eventId: 'storefront.offer.submitted' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      // As-of predates the offer — the fact is not yet valid, so a
      // grounded answer is impossible: refuse.
      {
        query: 'What offer did Anya Kovac submit?',
        asOf: ISO('2026-03-01'),
        expectRefusal: true,
      },
      // Control — no asOf, the offer is current truth.
      { query: 'What offer did Anya Kovac submit?', faithfulnessFloor: 0.85 },
    ],
  },
  {
    id: 'shop.false-premise.invented-preference',
    vertical: 'shop',
    description:
      'Rohit prefers headphones; ask his favourite wine (never stated). Must refuse.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit2' },
        predicate: 'name',
        object: 'Rohit Nair',
        validFrom: ISO('2026-03-10'),
        confidence: 0.95,
        source: { vertical: 'shop' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'shop', id: 'rohit2' },
        predicate: 'preference',
        object: 'noise-cancelling headphones',
        validFrom: ISO('2026-03-12'),
        confidence: 0.85,
        source: { vertical: 'shop' },
      },
    ],
    queries: [],
    synthesizeQueries: [
      { query: "What is Rohit Nair's favourite wine?", expectRefusal: true },
      { query: 'What does Rohit Nair prefer to buy?', faithfulnessFloor: 0.85 },
    ],
  },
];
