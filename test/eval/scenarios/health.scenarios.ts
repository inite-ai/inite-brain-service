import { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Health vertical exists primarily to exercise the PII gating path.
 * `address` and `dob` are pii_class=sensitive (require brain:read_pii).
 *
 * Scenario asserts:
 *  - operator without brain:read_pii does NOT see address/dob facts
 *    (mustBeAbsent queries)
 *  - operator WITH brain:read_pii does see them (regular query)
 */
export const healthScenarios: Scenario[] = [
  {
    id: 'health.pii-gating',
    vertical: 'health',
    description:
      'Patient profile carries sensitive PII. Without brain:read_pii scope, address-style queries must NOT surface the patient.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_42' },
        predicate: 'name',
        object: 'Karin Lindgren',
        validFrom: ISO('2026-03-01'),
        confidence: 0.95,
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_42' },
        predicate: 'address',
        object: '8 Linden St, Berlin',
        validFrom: ISO('2026-03-01'),
        confidence: 0.95,
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_42' },
        predicate: 'dob',
        object: '1981-06-12',
        validFrom: ISO('2026-03-01'),
        confidence: 1.0,
        source: { vertical: 'health' },
      },
    ],
    queries: [
      // Caller without brain:read_pii — entity may surface (via the
      // non-PII `name` fact), but the gated predicate MUST be stripped
      // from the returned facts. This is the brain's stated semantics:
      // facts gated, not entities.
      {
        query: 'patient at 8 Linden St',
        expectedTopEntityRef: 'health.patient_42',
        callerScopes: ['brain:read'],
        mustNotLeakPredicate: 'address',
      },
      {
        query: 'patient born in 1981',
        expectedTopEntityRef: 'health.patient_42',
        callerScopes: ['brain:read'],
        mustNotLeakPredicate: 'dob',
      },
      // Same query WITH brain:read_pii — should find them and the
      // address fact should be present in the response.
      {
        query: 'patient at 8 Linden St',
        expectedTopEntityRef: 'health.patient_42',
        callerScopes: ['brain:read', 'brain:read_pii'],
        expectedFactPredicate: 'address',
      },
      {
        query: 'Karin Lindgren date of birth',
        expectedTopEntityRef: 'health.patient_42',
        callerScopes: ['brain:read', 'brain:read_pii'],
        expectedFactPredicate: 'dob',
      },
    ],
  },
  {
    id: 'health.appointment-and-symptom',
    vertical: 'health',
    description:
      'Patient with reported symptom + scheduled follow-up. Covers reported_symptom predicate (uncommon class — small-N coverage today) and PII-gated phone number alongside non-PII appointment data.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_77' },
        predicate: 'name',
        object: 'Tomás Iglesias',
        validFrom: ISO('2026-04-10'),
        confidence: 0.95,
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_77' },
        predicate: 'phone',
        object: '+34 600 123 456',
        validFrom: ISO('2026-04-10'),
        confidence: 0.95,
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_77' },
        predicate: 'reported_symptom',
        object: 'persistent migraine, photophobia',
        validFrom: ISO('2026-04-12'),
        source: { vertical: 'health' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'health', id: 'patient_77' },
        predicate: 'interacted_with',
        object: 'scheduled follow-up: 2026-05-15 with Dr Mendes',
        validFrom: ISO('2026-04-12'),
        source: { vertical: 'health' },
      },
    ],
    queries: [
      {
        query: 'patients with migraine symptoms',
        expectedTopEntityRef: 'health.patient_77',
        expectedFactPredicate: 'reported_symptom',
      },
      {
        query: 'who scheduled a follow-up with Dr Mendes',
        expectedTopEntityRef: 'health.patient_77',
        expectedFactPredicate: 'interacted_with',
      },
      // phone is piiClass=identifier (not sensitive) per spec — surfaces
      // for non-PII callers. Asserting predicate is correctly returned.
      {
        query: 'Tomás Iglesias phone',
        expectedTopEntityRef: 'health.patient_77',
        expectedFactPredicate: 'phone',
      },
    ],
    // Synthesize smoke for health vertical. Patient has reported_symptom
    // + interacted_with (follow-up); the answer should describe both
    // without inventing diagnoses or dates.
    synthesizeQueries: [
      {
        query: 'tell me about Tomás Iglesias condition and follow-up',
        faithfulnessFloor: 0.85,
      },
    ],
  },
];
