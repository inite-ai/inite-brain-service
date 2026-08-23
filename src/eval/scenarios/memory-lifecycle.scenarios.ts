import type { Scenario } from '../types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Memory-lifecycle scenarios. Validate that brain's read side
 * reflects the WRITE semantics declared in the spec for each
 * predicate's policy:
 *
 *   - update / supersede (single_active, bitemporal): newer fact
 *     replaces older; default search returns the new object only.
 *   - competing (bitemporal): two contradicting facts at similar
 *     score keep both active in COMPETING status; both visible.
 *   - retract: a retracted fact must not surface in default search;
 *     asOf-historical search WITH includeRetracted should still find
 *     it (proves the audit trail survives).
 *   - forget: cascade-delete every fact, edge, embedding under the
 *     entity. Default search must produce ZERO hits matching the
 *     forgotten entity, on every query angle (name, email, complaint,
 *     interaction).
 *
 * Object substrings used in assertions are intentionally distinctive
 * (e.g. "memlc_unique_keyword") so they don't collide with other
 * scenarios' fact texts when the runner queries cross-scenario.
 */

const verticals = 'memlc'; // memory-lifecycle scenario tag — short, unique

export const memoryLifecycleScenarios: Scenario[] = [
  // ── 1. UPDATE / SUPERSEDE ──────────────────────────────────────────
  {
    id: 'memlc.update.tier-upgrade',
    vertical: 'cross',
    description:
      'Customer tier upgraded gold → platinum. Default search returns the platinum object; gold is gone from default search but timeline still has it.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'tier-upgrade-customer' },
        predicate: 'name',
        object: 'Memlc Tierupgrade Customer',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'tier-upgrade-customer' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-02-01'),
        validUntil: ISO('2026-04-01'),
        confidence: 0.9,
        source: { vertical: verticals, eventId: 'memlc.tier.gold' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'tier-upgrade-customer' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: verticals, eventId: 'memlc.tier.platinum' },
      },
    ],
    queries: [
      {
        query: 'Memlc Tierupgrade Customer tier',
        expectedTopEntityRef: `${verticals}.tier-upgrade-customer`,
        expectedFactPredicate: 'tier',
      },
    ],
    memoryAssertions: [
      {
        description: 'platinum tier surfaces on default search',
        kind: 'search_object_present',
        query: 'Memlc Tierupgrade Customer tier',
        expectedRefPresent: `${verticals}.tier-upgrade-customer`,
        objectSubstring: 'platinum',
      },
      {
        description: 'gold tier no longer surfaces on default search',
        kind: 'search_object_absent',
        query: 'Memlc Tierupgrade Customer tier',
        expectedRefAbsent: `${verticals}.tier-upgrade-customer`,
        objectSubstring: 'gold',
      },
    ],
  },

  // ── 2. RETRACT ─────────────────────────────────────────────────────
  {
    id: 'memlc.retract.complaint-walk-back',
    vertical: 'cross',
    description:
      'Tenant retracted a complaint they later said was wrong. Default search must drop the complaint object; entity still findable by name. asOf=before-retract WITH includeRetracted should still surface it.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'retract-tenant' },
        predicate: 'name',
        object: 'Memlc Retract Tenant',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'retract-tenant' },
        predicate: 'complained_about',
        object: 'memlcunique appliance malfunction in unit',
        validFrom: ISO('2026-03-01'),
        confidence: 0.9,
        source: { vertical: verticals, messageId: 'memlc.retract.complaint' },
        tag: 'retract-complaint',
      },
      {
        kind: 'retract',
        tag: 'retract-complaint',
        reason: 'tenant withdrew the report',
      },
    ],
    queries: [
      {
        query: 'Memlc Retract Tenant',
        expectedTopEntityRef: `${verticals}.retract-tenant`,
      },
    ],
    memoryAssertions: [
      {
        description: 'retracted complaint object does not surface in default search',
        kind: 'search_object_absent',
        query: 'memlcunique appliance malfunction',
        expectedRefAbsent: `${verticals}.retract-tenant`,
        objectSubstring: 'memlcunique appliance malfunction',
      },
      {
        description:
          'retracted complaint still surfaces on includeRetracted=true asOf the active window (audit trail intact)',
        kind: 'search_object_present',
        query: 'memlcunique appliance malfunction',
        expectedRefPresent: `${verticals}.retract-tenant`,
        objectSubstring: 'memlcunique appliance malfunction',
        includeRetracted: true,
        asOf: ISO('2026-03-15'),
      },
    ],
  },

  // ── 3. FORGET (GDPR) ───────────────────────────────────────────────
  {
    id: 'memlc.forget.gdpr-cascade',
    vertical: 'cross',
    description:
      'GDPR forget on a customer with name + email + complaint + interaction. Every angle of the entity must vanish from default search; only an HMAC tombstone remains (not asserted here — checked by unit/e2e suites).',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'forget-subject' },
        predicate: 'name',
        object: 'Memlc Forget Subject Uniquename',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'forget-subject' },
        predicate: 'email',
        object: 'memlc.forget.unique@example.test',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'forget-subject' },
        predicate: 'complained_about',
        object: 'memlcforgetkw distinctive complaint pattern',
        validFrom: ISO('2026-02-15'),
        confidence: 0.9,
        source: { vertical: verticals, messageId: 'memlc.forget.complaint' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'forget-subject' },
        predicate: 'interacted_with',
        object: 'memlcforgetkw event attendance trace',
        validFrom: ISO('2026-03-20'),
        confidence: 0.9,
        source: { vertical: verticals, eventId: 'memlc.forget.event' },
      },
      {
        kind: 'forget',
        entityRef: { vertical: verticals, id: 'forget-subject' },
        reason: 'gdpr_request',
        requestId: 'GDPR-MEMLC-001',
      },
    ],
    queries: [],
    memoryAssertions: [
      {
        description: 'forgotten subject no longer surfaces on a name query',
        kind: 'no_search_match',
        query: 'Memlc Forget Subject Uniquename',
        expectedRefAbsent: `${verticals}.forget-subject`,
      },
      {
        description: 'forgotten subject no longer surfaces on an email query',
        kind: 'no_search_match',
        query: 'memlc.forget.unique@example.test',
        expectedRefAbsent: `${verticals}.forget-subject`,
      },
      {
        description: 'forgotten subject no longer surfaces on a complaint-content query',
        kind: 'no_search_match',
        query: 'memlcforgetkw distinctive complaint pattern',
        expectedRefAbsent: `${verticals}.forget-subject`,
      },
      {
        description: 'forgotten subject no longer surfaces on an interaction query',
        kind: 'no_search_match',
        query: 'memlcforgetkw event attendance',
        expectedRefAbsent: `${verticals}.forget-subject`,
      },
    ],
  },

  // ── 4. UPDATE + RETRACT (cycle) ────────────────────────────────────
  {
    id: 'memlc.cycle.update-then-retract',
    vertical: 'cross',
    description:
      'Status updated active → churned, then the churn fact retracted (operator mistake). Default search must show NEITHER churn nor active separately — the active fact (validFrom older) is the surviving truth.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'cycle-customer' },
        predicate: 'name',
        object: 'Memlc Cycle Customer',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'cycle-customer' },
        predicate: 'status',
        object: 'active',
        validFrom: ISO('2026-01-15'),
        confidence: 0.9,
        source: { vertical: verticals, eventId: 'memlc.status.active' },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'cycle-customer' },
        predicate: 'status',
        object: 'churned',
        validFrom: ISO('2026-04-10'),
        confidence: 0.9,
        source: { vertical: verticals, eventId: 'memlc.status.churned' },
        tag: 'cycle-churn',
      },
      {
        kind: 'retract',
        tag: 'cycle-churn',
        reason: 'operator mistakenly recorded churn for the wrong account',
      },
    ],
    queries: [],
    memoryAssertions: [
      {
        description:
          'after the churn fact was retracted, the active status is the surviving truth surfaced by default search',
        kind: 'search_object_present',
        query: 'Memlc Cycle Customer status',
        expectedRefPresent: `${verticals}.cycle-customer`,
        objectSubstring: 'active',
      },
      {
        description: 'retracted churn does NOT surface alongside active in default search',
        kind: 'search_object_absent',
        query: 'Memlc Cycle Customer status',
        expectedRefAbsent: `${verticals}.cycle-customer`,
        objectSubstring: 'churned',
      },
    ],
  },

  // ── 5. SUPERSEDE CHAIN (3 hops) ────────────────────────────────────
  {
    id: 'memlc.supersede-chain.tier-trajectory',
    vertical: 'cross',
    description:
      'Tier moved standard → gold → platinum across three months. Only platinum should surface on default search; gold and standard live in the timeline.',
    setup: [
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'supersede-customer' },
        predicate: 'name',
        object: 'Memlc Supersede Customer',
        validFrom: ISO('2026-01-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'supersede-customer' },
        predicate: 'tier',
        object: 'standard',
        validFrom: ISO('2026-01-15'),
        validUntil: ISO('2026-02-15'),
        confidence: 0.9,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'supersede-customer' },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-02-15'),
        validUntil: ISO('2026-04-01'),
        confidence: 0.92,
        source: { vertical: verticals },
      },
      {
        kind: 'fact',
        entityRef: { vertical: verticals, id: 'supersede-customer' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: verticals },
      },
    ],
    queries: [],
    memoryAssertions: [
      {
        description: 'platinum tier surfaces on default search',
        kind: 'search_object_present',
        query: 'Memlc Supersede Customer tier',
        expectedRefPresent: `${verticals}.supersede-customer`,
        objectSubstring: 'platinum',
      },
      {
        description: 'standard tier (oldest, validUntil set) is gone',
        kind: 'search_object_absent',
        query: 'Memlc Supersede Customer tier',
        expectedRefAbsent: `${verticals}.supersede-customer`,
        objectSubstring: 'standard',
      },
      {
        description: 'gold tier (middle, validUntil set) is also gone',
        kind: 'search_object_absent',
        query: 'Memlc Supersede Customer tier',
        expectedRefAbsent: `${verticals}.supersede-customer`,
        objectSubstring: 'gold',
      },
    ],
  },
];
