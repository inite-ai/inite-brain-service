import type { Scenario } from '../types';

/**
 * Demo-talk scenarios — designed to be RUN LIVE during the "Memory that
 * doesn't lie" talk (brain_deck slides 9-11, 14). Each scenario maps to
 * exactly one slide moment so the operator can clear-table → click Run →
 * point at the result without explaining what they're about to do.
 *
 * Vertical choice is `shop` for everything — it's the most familiar
 * tenant shape (a customer with attributes that change over time, get
 * corrected, or get forgotten) and the audience doesn't need to track
 * vertical-specific jargon.
 */

const ISO = (d: string) => new Date(d).toISOString();

/**
 * SLIDE 9 — bitemporal.
 *
 * Acme switched plan from `starter` → `growth` on 2026-03-10. Two queries
 * proving brain reads the time-axis correctly:
 *   1. "What plan is Acme on?"            → growth   (current truth)
 *   2. "What plan was Acme on?" asOf=Feb  → starter  (frozen historical view)
 *
 * The slide line "В марте мы видим мартовскую истину, даже если сегодня
 * факт уже отозван" is precisely what asOf=2026-02-01 demonstrates here.
 */
const bitemporalTariff: Scenario = {
  id: 'demo-bitemporal-tariff',
  vertical: 'shop',
  description:
    'Slide 9 demo. Acme upgrades plan starter → growth on 2026-03-10. As-of February returns the old plan, current query returns the new plan — same entity, two truths frozen in time.',
  setup: [
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'name',
      object: 'Acme',
      validFrom: ISO('2026-01-15'),
      source: { vertical: 'shop', eventId: 'billing.signup' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'plan',
      object: 'starter',
      validFrom: ISO('2026-01-15'),
      validUntil: ISO('2026-03-10'),
      confidence: 0.98,
      source: { vertical: 'shop', eventId: 'billing.subscribe' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'plan',
      object: 'growth',
      validFrom: ISO('2026-03-10'),
      confidence: 0.98,
      source: { vertical: 'shop', eventId: 'billing.upgrade' },
    },
  ],
  queries: [
    {
      query: 'Acme plan',
      expectedTopEntityRef: 'shop.acme',
      expectedFactPredicate: 'plan',
    },
    {
      query: 'Acme plan',
      expectedTopEntityRef: 'shop.acme',
      expectedFactPredicate: 'plan',
      asOf: ISO('2026-02-01'),
    },
  ],
  memoryAssertions: [
    {
      description: 'Current state surfaces the new plan',
      kind: 'search_object_present',
      query: 'Acme plan',
      expectedRefPresent: 'shop.acme',
      objectSubstring: 'growth',
    },
    {
      description: 'As-of February — old plan still visible, no growth yet',
      kind: 'search_object_absent',
      query: 'Acme plan',
      expectedRefAbsent: 'shop.acme',
      objectSubstring: 'growth',
      asOf: ISO('2026-02-01'),
    },
  ],
};

/**
 * SLIDE 10 — retract.
 *
 * Acme was tagged industry=`media` from a noisy mention extraction. Ops
 * corrected it to `fintech` and retracted the original fact. Two checks:
 *   1. Default search no longer surfaces `media`           (correctness)
 *   2. The fact is gone from the live answer surface       (slide line:
 *      "факт был, теперь отозван · для исправлений и supersede").
 *
 * The point on stage is the distinction from forget — the retracted fact
 * still exists in the audit timeline (timeline endpoint, not asserted here
 * to keep the demo simple), it just stopped influencing answers.
 */
const retractCorrection: Scenario = {
  id: 'demo-retract-correction',
  vertical: 'shop',
  description:
    'Slide 10 demo (RETRACT). Noisy extraction labeled Acme industry=media. Ops corrected to fintech and retracted the bad fact. Default search returns fintech — media stops influencing answers immediately, no waiting for re-ingest.',
  setup: [
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'name',
      object: 'Acme',
      validFrom: ISO('2026-01-15'),
      source: { vertical: 'shop' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'industry',
      object: 'media',
      validFrom: ISO('2026-02-01'),
      confidence: 0.55,
      source: { vertical: 'shop', messageId: 'inbox.123' },
      tag: 'wrong_industry',
    },
    {
      kind: 'retract',
      tag: 'wrong_industry',
      reason: 'operator_correction: customer is fintech, not media',
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'industry',
      object: 'fintech',
      validFrom: ISO('2026-02-15'),
      confidence: 0.95,
      source: { vertical: 'shop', eventId: 'crm.profile_update' },
    },
  ],
  queries: [
    {
      query: 'Acme industry',
      expectedTopEntityRef: 'shop.acme',
      expectedFactPredicate: 'industry',
    },
  ],
  memoryAssertions: [
    {
      description: 'Retracted fact does NOT surface for the live answer',
      kind: 'search_object_absent',
      query: 'Acme industry',
      expectedRefAbsent: 'shop.acme',
      objectSubstring: 'media',
    },
    {
      description: 'Corrected fact takes over — fintech surfaces instead',
      kind: 'search_object_present',
      query: 'Acme industry',
      expectedRefPresent: 'shop.acme',
      objectSubstring: 'fintech',
    },
  ],
};

/**
 * SLIDE 10 — forget (GDPR Article 17).
 *
 * Customer `marie` (PII-bearing) requested erasure. Forget cascades —
 * facts + edges drop, only an opaque HMAC tombstone remains. Searching
 * by the forgotten name returns nothing on the regular surface; the
 * neighbouring (non-forgotten) customer still works. This is the
 * "Протечка областей" defence from slide 5: forgetting one customer
 * MUST NOT degrade another tenant or another customer in the same tenant.
 */
const forgetGdpr: Scenario = {
  id: 'demo-forget-gdpr',
  vertical: 'shop',
  description:
    'Slide 10 demo (FORGET). Customer Marie exercises GDPR Article 17. Forget cascade removes her facts; searching for her returns nothing. The neighbouring customer Alex is untouched — the legal delete is per-subject, not per-tenant.',
  setup: [
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'marie' },
      predicate: 'name',
      object: 'Marie Lefèvre',
      validFrom: ISO('2026-01-10'),
      source: { vertical: 'shop' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'marie' },
      predicate: 'plan',
      object: 'enterprise',
      validFrom: ISO('2026-01-10'),
      source: { vertical: 'shop', eventId: 'billing.signup' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'alex' },
      predicate: 'name',
      object: 'Alex Hartman',
      validFrom: ISO('2026-01-12'),
      source: { vertical: 'shop' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'alex' },
      predicate: 'plan',
      object: 'growth',
      validFrom: ISO('2026-01-12'),
      source: { vertical: 'shop', eventId: 'billing.signup' },
    },
    {
      kind: 'forget',
      entityRef: { vertical: 'shop', id: 'marie' },
      reason: 'gdpr_request',
      requestId: 'gdpr-2026-001',
    },
  ],
  queries: [
    // Alex should still rank #1 for "Alex" — forget left the rest of the
    // tenant untouched. The runner's primary check.
    {
      query: 'Alex Hartman plan',
      expectedTopEntityRef: 'shop.alex',
      expectedFactPredicate: 'plan',
    },
  ],
  memoryAssertions: [
    {
      description: 'Forgotten customer does not surface for her own name',
      kind: 'no_search_match',
      query: 'Marie Lefèvre',
      expectedRefAbsent: 'shop.marie',
    },
    {
      description: 'Forgotten customer does not surface for her old plan',
      kind: 'no_search_match',
      query: 'enterprise plan customer',
      expectedRefAbsent: 'shop.marie',
    },
    {
      description: 'Neighbouring customer untouched after forget',
      kind: 'search_object_present',
      query: 'Alex Hartman',
      expectedRefPresent: 'shop.alex',
      objectSubstring: 'growth',
    },
  ],
};

/**
 * SLIDE 6 / SLIDE 14 — scopes.
 *
 * A support agent asks for the contact info on Acme. The setup loads
 * three facts: name + email (identifier-class, visible to any caller)
 * + address (sensitive-class, gated behind brain:read_pii via
 * migration 0005). A non-PII caller sees the first two but the
 * address fact never leaves the server — the gate runs per-predicate
 * inside SurrealDB PERMISSIONS.
 *
 * The dramatic point on stage: brain doesn't gate the whole entity
 * (the agent isn't blind), and it doesn't gate the whole record —
 * just the gated facts. Plain RAG has no concept of fact-level
 * scope at all.
 */
const piiGatingSupport: Scenario = {
  id: 'demo-pii-gating',
  vertical: 'shop',
  description:
    'Slide 6 / 14 demo (SCOPES). Acme has email (identifier-class) and headquarters address (sensitive-class, gated). A non-PII caller searches and gets back the entity + email — but address never leaves the server. Per-predicate gating.',
  setup: [
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'name',
      object: 'Acme',
      validFrom: ISO('2026-01-15'),
      source: { vertical: 'shop' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'email',
      object: 'hello@acme.example',
      validFrom: ISO('2026-01-15'),
      source: { vertical: 'shop', eventId: 'crm.profile_update' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'address',
      object: '1 Market St, San Francisco',
      validFrom: ISO('2026-01-15'),
      source: { vertical: 'shop', eventId: 'crm.profile_update' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'shop', id: 'acme' },
      predicate: 'plan',
      object: 'growth',
      validFrom: ISO('2026-03-10'),
      source: { vertical: 'shop', eventId: 'billing.upgrade' },
    },
  ],
  queries: [
    // Non-PII caller. Entity surfaces (search routes on name + plan,
    // which are non-sensitive), and identifier-class facts like email
    // pass through. But `address` is sensitive-class, so SurrealDB's
    // PERMISSIONS clause strips its object server-side. The runner
    // enforces this by dropping brain:read_pii from the caller scope
    // set whenever mustNotLeakPredicate is set.
    {
      query: 'Acme office address',
      expectedTopEntityRef: 'shop.acme',
      mustNotLeakPredicate: 'address',
    },
  ],
};

export const demoTalkScenarios: Scenario[] = [
  bitemporalTariff,
  retractCorrection,
  forgetGdpr,
  piiGatingSupport,
];
