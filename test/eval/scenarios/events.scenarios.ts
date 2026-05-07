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
    ],
  },
];
