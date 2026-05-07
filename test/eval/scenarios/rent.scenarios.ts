/**
 * Scenarios mimicking real inite.rent flows:
 *  - inbound TG/web message → mention extraction
 *  - vertical webhook emitting structured facts
 *  - operator searching for an issue / customer profile
 *
 * Each scenario seeds a small per-tenant graph, then asks queries an
 * actual rent-vertical UI / agent might run.
 */

import { Scenario } from '../types';
import { rentMessages } from '../fixtures/rent.fixtures';

const ISO = (d: string) => new Date(d).toISOString();

export const rentScenarios: Scenario[] = [
  {
    id: 'rent.heating-complaint-search',
    vertical: 'rent',
    description:
      'Tenant complains about heating via TG. Operator later searches for heating issues; brain should surface Anna.',
    setup: [
      // Structured facts from TG webhook + CRM
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
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-04-01'),
        confidence: 0.9,
        source: { vertical: 'rent' },
      },
      // Distractor — different tenant with parking complaint
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'bob' },
        predicate: 'name',
        object: 'Bob Jones',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'bob' },
        predicate: 'complained_about',
        object: 'parking spot reassignment',
        validFrom: ISO('2026-04-15'),
        source: { vertical: 'rent', messageId: 'msg_bob_1' },
      },
      // The actual heating mention from Anna — LLM extraction
      {
        kind: 'mention',
        text: rentMessages.annaHeating,
        contextRef: { vertical: 'rent', conversationId: 'conv_anna_1', messageId: 'msg_anna_1' },
        knownEntities: [{ vertical: 'rent', id: 'anna', role: 'speaker' }],
        emittedAt: ISO('2026-05-01'),
        // annaHeating text complains about radiator + reports calling
        // maintenance with no response. The extractor's prompt prefers
        // the most specific predicate, so a generic `said` mirror is
        // omitted in favour of `complained_about` + `interacted_with`.
        expectedPredicates: ['complained_about', 'interacted_with'],
      },
    ],
    queries: [
      {
        query: 'tenant complaints about heating not working',
        expectedTopEntityRef: 'rent.anna',
        expectedFactPredicate: 'complained_about',
      },
      {
        query: 'who has a noisy radiator',
        expectedTopEntityRef: 'rent.anna',
      },
    ],
  },

  {
    id: 'rent.payment-failure',
    vertical: 'rent',
    description:
      'Customer reports a payment-card change after a failed charge. Search by "payment problems" should find Bjorn.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'bjorn' },
        predicate: 'name',
        object: 'Bjorn Madsen',
        validFrom: ISO('2026-03-15'),
        confidence: 0.95,
        source: { vertical: 'rent' },
      },
      // Billing event — structured fact, high source-trust
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'bjorn' },
        predicate: 'interacted_with',
        object: 'payment declined: card expired',
        validFrom: ISO('2026-04-30'),
        confidence: 0.95,
        source: { vertical: 'rent', eventId: 'billing.payment.failed' },
      },
      {
        kind: 'mention',
        text: rentMessages.bjornPaymentFail,
        contextRef: { vertical: 'rent', conversationId: 'conv_bjorn', messageId: 'msg_bjorn_1' },
        knownEntities: [{ vertical: 'rent', id: 'bjorn', role: 'speaker' }],
        emittedAt: ISO('2026-05-01'),
        // bjornPaymentFail text introduces the speaker's name and
        // reports a failed charge / asks for help. Generic `said` is
        // suppressed in favour of `complained_about` + `name`.
        expectedPredicates: ['name', 'complained_about'],
      },
      // Distractor — Anna again (she has no payment issues)
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'anna' },
        predicate: 'name',
        object: 'Anna Schmidt',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
    ],
    queries: [
      {
        query: 'recent payment failures from tenants',
        expectedTopEntityRef: 'rent.bjorn',
      },
      {
        query: 'who needs to update their card',
        expectedTopEntityRef: 'rent.bjorn',
      },
    ],
  },

  {
    id: 'rent.tier-upgrade-intent',
    vertical: 'rent',
    description:
      'Anna mentions a tier-upgrade intent in chat; operator searches for upgrade-interested tenants.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'anna' },
        predicate: 'name',
        object: 'Anna Schmidt',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: 'rent', id: 'anna' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'rent' },
      },
      {
        kind: 'mention',
        text: rentMessages.annaUpgradeIntent,
        contextRef: { vertical: 'rent', conversationId: 'conv_anna_2', messageId: 'msg_anna_upgrade' },
        knownEntities: [{ vertical: 'rent', id: 'anna', role: 'speaker' }],
        emittedAt: ISO('2026-05-02'),
        // annaUpgradeIntent text expresses an intent to upgrade plus a
        // preference for valet parking. Generic `said` is suppressed.
        expectedPredicates: ['intent'],
      },
    ],
    queries: [
      {
        query: 'tenants interested in upgrading their plan',
        expectedTopEntityRef: 'rent.anna',
      },
    ],
  },
];
