import { Scenario } from '../types';
import { eventsMessages } from '../fixtures/events.fixtures';

const ISO = (d: string) => new Date(d).toISOString();

export const eventsScenarios: Scenario[] = [
  {
    id: 'events.vip-mis-seating',
    vertical: 'events',
    description:
      'Repeat ticket buyer complains about VIP seating mismatch. Operator searches for unhappy VIP attendees.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'irene' },
        predicate: 'name',
        object: 'Irene Holm',
        validFrom: ISO('2026-03-01'),
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'irene' },
        predicate: 'tier',
        object: 'vip',
        validFrom: ISO('2026-03-01'),
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'irene' },
        predicate: 'interacted_with',
        object: 'attended: jazz night at The Grove (VIP)',
        validFrom: ISO('2026-04-29'),
        source: { vertical: 'events', eventId: 'storefront.order.created' },
      },
      {
        kind: 'mention',
        text: eventsMessages.ireneComplaint,
        contextRef: { vertical: 'events', conversationId: 'conv_irene_1' },
        knownEntities: [{ vertical: 'events', id: 'irene', role: 'speaker' }],
        emittedAt: ISO('2026-04-30'),
        // ireneComplaint text reports a seating issue + asks for a
        // refund/upgrade. Extractor reliably produces
        // `complained_about` + `interacted_with` (purchase). The
        // refund-request phrasing is ambiguous between `intent` and
        // a domain-specific `tier upgrade` interpretation, so we
        // don't pin it.
        expectedPredicates: ['complained_about', 'interacted_with'],
      },
      // Distractor
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'sam' },
        predicate: 'name',
        object: 'Sam Goldberg',
        validFrom: ISO('2026-03-01'),
        source: { vertical: 'events' },
      },
    ],
    queries: [
      {
        query: 'VIP attendees who complained recently',
        expectedTopEntityRef: 'events.irene',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'who had seating issues at the jazz night',
        expectedTopEntityRef: 'events.irene',
      },
      {
        query: 'Irene Holm',
        expectedTopEntityRef: 'events.irene',
        expectedFactPredicate: 'name',
      },
      {
        query: 'platinum tier attendee at The Grove',
        expectedTopEntityRef: 'events.irene',
        expectedFactPredicate: 'tier',
      },
    ],
  },
  {
    id: 'events.repeat-buyer-refund',
    vertical: 'events',
    description:
      'Repeat ticket buyer requested a refund after a cancelled show. Covers refund-intent classification (intent vs complained_about disambiguation) and email-as-PII gating.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'noah' },
        predicate: 'name',
        object: 'Noah Berggren',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'noah' },
        predicate: 'email',
        object: 'noah.berggren@example.com',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: 'events' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'noah' },
        predicate: 'interacted_with',
        object: 'purchased: indie rock show at Veranda',
        validFrom: ISO('2026-04-15'),
        source: { vertical: 'events', eventId: 'storefront.order.created' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'events', id: 'noah' },
        predicate: 'intent',
        object: 'requested refund after Veranda cancellation',
        validFrom: ISO('2026-04-28'),
        source: { vertical: 'events' },
      },
    ],
    queries: [
      {
        query: 'attendees who asked for a refund',
        expectedTopEntityRef: 'events.noah',
        expectedFactPredicate: 'intent',
      },
      {
        query: 'who bought tickets to the Veranda show',
        expectedTopEntityRef: 'events.noah',
        expectedFactPredicate: 'interacted_with',
      },
      // email surfaces for non-PII callers per knowledge.yaml policy
      // (piiClass=identifier, not sensitive — DB-level PERMISSIONS in
      // 0005_pii_permissions.surql intentionally exclude email/phone
      // from the gate). Asserting expectedFactPredicate instead.
      {
        query: 'Noah Berggren email',
        expectedTopEntityRef: 'events.noah',
        expectedFactPredicate: 'email',
      },
    ],
    // Synthesize smoke for the events vertical. Noah has interacted_with
    // (purchase) + intent (refund) facts; the answer should ground in
    // both without inventing details.
    synthesizeQueries: [
      {
        query: 'what did Noah Berggren request after the Veranda show',
        faithfulnessFloor: 0.85,
      },
    ],
  },
];
