/**
 * Fat-tenant generator — programmatically build a mid-scale tenant
 * fixture (~500 entities, ~3-5k facts) so retrieval techniques that
 * depend on graph density (PPR, GraphRAG, GNN-style) can be measured
 * outside the small-scale (~30 entities) regime where hub effects
 * pathologically dominate.
 *
 * Design goals:
 * - Deterministic. Seeded RNG so the same generator emits the same
 *   tenant on every CI run — eval scores are comparable across
 *   commits.
 * - Cheap to run. No LLM extraction in the build path; entities and
 *   facts are written via `kind: 'fact'` setup steps. The eval
 *   harness only pays for embeddings on the query path.
 * - Targets specific failure modes: shared-firstname disambiguation,
 *   hub-vs-leaf entity confusion, multi-hop graph traversal,
 *   bitemporal asOf on dense fact histories.
 */
import type { Scenario, SetupStep } from '../../../src/eval/types';

const ISO = (d: string) => new Date(d).toISOString();

/**
 * Seeded mulberry32 PRNG. Cheap, deterministic, sufficient for
 * fixture generation (we don't need cryptographic strength).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Maria',
  'Maria',
  'Maria', // intentional repeats — shared-firstname adversarial
  'James',
  'James',
  'Anna',
  'Anna',
  'Liam',
  'Sophia',
  'Mateo',
  'Aiko',
  'Priya',
  'Rohit',
  'Yuki',
  'Zara',
  'Noah',
  'Ethan',
  'Olivia',
  'Mia',
  'Ava',
  'Sara',
  'Lucas',
  'Eva',
  'Carlos',
  'Diego',
  'Lina',
  'Elena',
  'Ravi',
  'Hassan',
  'Layla',
  'Klaus',
  'Greta',
  'Hans',
  'Ingrid',
];

const LAST_NAMES = [
  'Schmidt',
  'Müller',
  'Berg',
  'Park',
  'Kim',
  'Tanaka',
  'Volkov',
  'Rossi',
  'Khan',
  'Singh',
  'Petrova',
  'Nakamura',
  'Ng',
  'Reyes',
  'Chen',
  'Wong',
  'Holm',
  'Andersen',
  'Kowalski',
  'Novak',
  'Cohen',
  'Garcia',
  'Martin',
  'Costa',
  'Silva',
  'Ferraro',
  'Okafor',
  'Mensah',
];

const PROJECT_NAMES = [
  'Phoenix',
  'Atlas',
  'Helix',
  'Nimbus',
  'Orion',
  'Pulse',
  'Quartz',
  'Vector',
  'Zenith',
  'Hydra',
  'Ember',
  'Frost',
  'Compass',
  'Beacon',
];

const APPLIANCE_TOPICS = [
  'broken washing machine',
  'dishwasher leak',
  'fridge not cooling',
  "oven won't heat",
  'air conditioner rattling',
  'water heater failure',
];
const NOISE_TOPICS = [
  'late-night noise from upstairs',
  'loud music from neighbours',
  'construction noise during work hours',
  'barking dog next door',
];
const PARKING_TOPICS = [
  'parking spot taken by visitors',
  'electric vehicle charger broken',
  'parking gate not opening',
  'visitor parking abuse',
];
const PAYMENT_TOPICS = [
  'rent payment declined',
  'card expired and payment failed',
  'auto-pay not configured',
  'invoice missing line items',
];

export interface FatTenantOpts {
  seed?: number;
  customers?: number;
  staff?: number;
  projects?: number;
  /**
   * Fraction of customers that get a 3-hop temporal tier trajectory
   * (standard → gold → platinum) instead of one static tier fact.
   * Stresses bitemporal indices + supersede semantics. Default 0.3.
   */
  temporalTierFraction?: number;
  /**
   * Fraction of customers that receive a contradicting status fact
   * (active vs churned) at similar confidence — exercises the
   * conflict resolver's COMPETING outcome. Default 0.05.
   */
  competingStatusFraction?: number;
  /**
   * Fraction of complaints that get retracted post-ingest. Each
   * retraction is a tag→retract pair so the runner can validate
   * that retracted facts disappear from default search. Default 0.03.
   */
  retractedComplaintsFraction?: number;
  /**
   * Fraction of customers that are GDPR-forgotten after ingest.
   * Combined with directory-level memory assertions, exercises
   * cascade-completeness at scale. Default 0.01.
   */
  forgottenCustomersFraction?: number;
}

export interface FatTenantFixture {
  scenarios: Scenario[];
  /** Stats for diagnostics — total entities, total facts, etc. */
  stats: {
    customers: number;
    staff: number;
    projects: number;
    totalEntities: number;
    totalFacts: number;
    temporalTierCustomers: number;
    competingStatusCustomers: number;
    retractedComplaints: number;
    forgottenCustomers: number;
  };
}

/**
 * Build a fat-tenant fixture as a SINGLE scenario whose `setup` array
 * holds all entities + facts. The scenario's queries cover specific
 * retrieval failure modes: shared-firstname, hub-vs-leaf, multi-hop,
 * temporal-asof.
 *
 * One scenario means one tenant DB on the eval — no cross-tenant
 * pollution and no migration cost amortised over many small
 * tenants. The runner walks the setup linearly so 5k facts take a
 * few seconds to seed even with no LLM in the loop.
 */
export function buildFatTenant(opts: FatTenantOpts = {}): FatTenantFixture {
  const seed = opts.seed ?? 42;
  const customerCount = opts.customers ?? 500;
  const staffCount = opts.staff ?? 50;
  const projectCount = opts.projects ?? 30;
  const temporalTierFrac = opts.temporalTierFraction ?? 0.3;
  const competingStatusFrac = opts.competingStatusFraction ?? 0.05;
  const retractedComplaintsFrac = opts.retractedComplaintsFraction ?? 0.03;
  const forgottenCustomersFrac = opts.forgottenCustomersFraction ?? 0.01;
  const rand = mulberry32(seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const setup: SetupStep[] = [];
  let factCount = 0;
  let temporalTierCount = 0;
  let competingStatusCount = 0;
  let retractedComplaintCount = 0;
  let forgottenCustomerCount = 0;
  // Track which customers will be forgotten — needed for the
  // post-ingest forget steps and for memory assertions on those
  // entities. Track separately by attribute so the assertion list
  // can probe each angle (name, complaint object, payment event).
  const forgottenCustomers: Array<{
    id: string;
    fullName: string;
    complaintObject?: string | undefined;
    paymentObject?: string | undefined;
  }> = [];
  // Track retracted complaints so memory assertions can verify the
  // object string disappears from default search.
  const retractedComplaints: Array<{ id: string; object: string }> = [];
  // Track temporal-tier customers so memory assertions can verify
  // the latest tier surfaces and the older ones do not.
  const temporalTierCustomers: Array<{
    id: string;
    fullName: string;
    finalTier: string;
    staleTier: string;
  }> = [];

  // Customers — name + tier + a small pool of complaints/interactions.
  for (let i = 0; i < customerCount; i++) {
    const id = `cust_${i}`;
    const fullName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    setup.push({
      kind: 'fact',
      entityRef: { vertical: 'fat', id },
      predicate: 'name',
      object: fullName,
      validFrom: ISO('2026-01-01'),
      confidence: 0.95,
      source: { vertical: 'fat' },
    });
    factCount++;

    // Tier — most customers get one static fact; a fraction get a
    // 3-hop trajectory (standard → gold → platinum) so the eval
    // exercises the supersede chain on bitemporal predicates.
    const isTemporalTier = rand() < temporalTierFrac;
    if (isTemporalTier) {
      temporalTierCount++;
      // Three tier facts with bookended validFrom/validUntil. The
      // final fact carries no validUntil — that's the surviving
      // truth a default-search query should return.
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'tier',
        object: 'standard',
        validFrom: ISO('2026-01-15'),
        validUntil: ISO('2026-02-15'),
        confidence: 0.9,
        source: { vertical: 'fat', eventId: 'billing.tier_change' },
      });
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'tier',
        object: 'gold',
        validFrom: ISO('2026-02-15'),
        validUntil: ISO('2026-04-01'),
        confidence: 0.92,
        source: { vertical: 'fat', eventId: 'billing.tier_change' },
      });
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'tier',
        object: 'platinum',
        validFrom: ISO('2026-04-01'),
        confidence: 0.95,
        source: { vertical: 'fat', eventId: 'billing.tier_change' },
      });
      factCount += 3;
      temporalTierCustomers.push({
        id,
        fullName,
        finalTier: 'platinum',
        staleTier: 'standard',
      });
    } else {
      const tierRoll = rand();
      const tier = tierRoll < 0.2 ? 'platinum' : tierRoll < 0.7 ? 'gold' : 'standard';
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'tier',
        object: tier,
        validFrom: ISO('2026-02-01'),
        source: { vertical: 'fat' },
      });
      factCount++;
    }

    // Status — most customers get one fact (`active`). A small
    // fraction also receive a contradicting `churned` fact at near-
    // identical confidence, exercising the conflict resolver's
    // COMPETING outcome (both stay active until human resolution).
    setup.push({
      kind: 'fact',
      entityRef: { vertical: 'fat', id },
      predicate: 'status',
      object: 'active',
      validFrom: ISO('2026-01-15'),
      confidence: 0.85,
      source: { vertical: 'fat', eventId: 'crm.status' },
    });
    factCount++;
    if (rand() < competingStatusFrac) {
      competingStatusCount++;
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'status',
        object: 'churned',
        // Same validFrom — pure contradiction, not a temporal update.
        validFrom: ISO('2026-01-15'),
        confidence: 0.84,
        source: { vertical: 'fat', eventId: 'support.churn_signal' },
      });
      factCount++;
    }

    // 0-3 complaints per customer — most have none, a few have many.
    const complaints = Math.floor(rand() * 4);
    let firstComplaintObject: string | undefined;
    for (let c = 0; c < complaints; c++) {
      const topicPool =
        rand() < 0.4 ? APPLIANCE_TOPICS : rand() < 0.7 ? NOISE_TOPICS : PARKING_TOPICS;
      const obj = pick(topicPool);
      if (!firstComplaintObject) firstComplaintObject = obj;
      // A small slice of complaints are retracted post-ingest.
      // Tag the fact step so the retract step (emitted later) can
      // resolve the factId without round-tripping through the
      // server. Tag is unique per (customer, complaint-index).
      const willRetract = rand() < retractedComplaintsFrac;
      const tag = willRetract ? `cust_${i}_complaint_${c}` : undefined;
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'complained_about',
        object: obj,
        validFrom: ISO('2026-03-01'),
        source: { vertical: 'fat', messageId: `complaint_${id}_${c}` },
        ...(tag ? { tag } : {}),
      });
      factCount++;
      if (willRetract) {
        retractedComplaintCount++;
        retractedComplaints.push({ id, object: obj });
        setup.push({
          kind: 'retract',
          tag: tag!,
          reason: 'reporter walked it back',
        });
      }
    }

    // 0-2 payment events per customer.
    let paymentObject: string | undefined;
    if (rand() < 0.3) {
      paymentObject = pick(PAYMENT_TOPICS);
      setup.push({
        kind: 'fact',
        entityRef: { vertical: 'fat', id },
        predicate: 'interacted_with',
        object: paymentObject,
        validFrom: ISO('2026-04-01'),
        source: { vertical: 'fat', eventId: 'billing.payment' },
      });
      factCount++;
    }

    // Forget — flagged AFTER all the customer's data has been
    // ingested so the cascade has something to delete. Tracked
    // separately so the assertion-emitter can probe each angle
    // (name / complaint / payment) of the forgotten record.
    if (rand() < forgottenCustomersFrac) {
      forgottenCustomerCount++;
      forgottenCustomers.push({
        id,
        fullName,
        complaintObject: firstComplaintObject,
        paymentObject,
      });
    }
  }

  // Forget step — emitted AFTER all customer facts so the cascade
  // has the full footprint to delete in one shot.
  for (const fc of forgottenCustomers) {
    setup.push({
      kind: 'forget',
      entityRef: { vertical: 'fat', id: fc.id },
      reason: 'gdpr_request',
      requestId: `GDPR-FAT-${fc.id}`,
    });
  }

  // Staff — name + role + assigned-to-project.
  for (let i = 0; i < staffCount; i++) {
    const id = `staff_${i}`;
    const fullName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    setup.push({
      kind: 'fact',
      entityRef: { vertical: 'fat', id },
      predicate: 'name',
      object: fullName,
      validFrom: ISO('2026-01-01'),
      confidence: 0.98,
      source: { vertical: 'fat' },
    });
    factCount++;
  }

  // Projects — name + a few interactions referencing them.
  for (let i = 0; i < projectCount; i++) {
    const id = `proj_${i}`;
    const projName = `Project ${pick(PROJECT_NAMES)}`;
    setup.push({
      kind: 'fact',
      entityRef: { vertical: 'fat', id },
      predicate: 'name',
      object: projName,
      validFrom: ISO('2026-01-01'),
      confidence: 0.99,
      source: { vertical: 'fat' },
    });
    factCount++;
  }

  // Edges: each project has 2-5 staff associated via mentioned_with.
  for (let i = 0; i < projectCount; i++) {
    const projId = `proj_${i}`;
    const teamSize = 2 + Math.floor(rand() * 4);
    for (let t = 0; t < teamSize; t++) {
      const staffIdx = Math.floor(rand() * staffCount);
      setup.push({
        kind: 'link',
        from: { vertical: 'fat', id: `staff_${staffIdx}` },
        to: { vertical: 'fat', id: projId },
        linkKind: 'mentioned_with',
        source: { vertical: 'fat' },
      });
    }
  }

  // Edges: 30% of customers have a contact-staff relationship.
  for (let i = 0; i < customerCount; i++) {
    if (rand() < 0.3) {
      const staffIdx = Math.floor(rand() * staffCount);
      setup.push({
        kind: 'link',
        from: { vertical: 'fat', id: `cust_${i}` },
        to: { vertical: 'fat', id: `staff_${staffIdx}` },
        linkKind: 'mentioned_with',
        source: { vertical: 'fat' },
      });
    }
  }

  // Pin a handful of named anchor entities so the queries below
  // have stable expected references even though most of the tenant
  // is randomised. These override-by-id facts collide with the
  // generated ones via UNIQUE on entity_external_ref.key — the
  // ingest dedupes them onto the same entity.
  const anchorFacts: SetupStep[] = [
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_appliance_klaus' },
      predicate: 'name',
      object: 'Klaus Weber',
      validFrom: ISO('2026-04-01'),
      source: { vertical: 'fat' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_appliance_klaus' },
      predicate: 'complained_about',
      object: 'broken washing machine in unit 4B',
      validFrom: ISO('2026-04-10'),
      source: { vertical: 'fat', messageId: 'anchor_klaus_1' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_tier_maria' },
      predicate: 'name',
      object: 'Maria Volkov',
      validFrom: ISO('2026-01-01'),
      source: { vertical: 'fat' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_tier_maria' },
      predicate: 'tier',
      object: 'platinum',
      validFrom: ISO('2026-04-15'),
      source: { vertical: 'fat', eventId: 'billing.tier_change' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_phoenix_lead' },
      predicate: 'name',
      object: 'Olivia Park',
      validFrom: ISO('2026-01-01'),
      source: { vertical: 'fat' },
    },
    {
      kind: 'fact',
      entityRef: { vertical: 'fat', id: 'anchor_phoenix_lead' },
      predicate: 'interacted_with',
      object: 'led Project Phoenix kickoff',
      validFrom: ISO('2026-04-15'),
      source: { vertical: 'fat', eventId: 'auth.meeting' },
    },
  ];
  setup.push(...anchorFacts);
  factCount += anchorFacts.length;

  const queries = [
    // Anchor lookups — should resolve cleanly despite the noise.
    {
      query: 'Klaus Weber appliance complaint',
      expectedTopEntityRef: 'fat.anchor_appliance_klaus',
      expectedFactPredicate: 'complained_about',
    },
    {
      query: 'Maria Volkov platinum tier',
      expectedTopEntityRef: 'fat.anchor_tier_maria',
      expectedFactPredicate: 'tier',
    },
    {
      query: 'who led Project Phoenix kickoff',
      expectedTopEntityRef: 'fat.anchor_phoenix_lead',
      expectedFactPredicate: 'interacted_with',
    },
    // Disambiguation — the random name pool guarantees many "Maria"s,
    // we expect the anchor's specific facts to disambiguate.
    {
      query: 'Maria with platinum tier',
      expectedTopEntityRef: 'fat.anchor_tier_maria',
    },
  ];

  // Memory-lifecycle assertions emitted from the directory shape:
  //   - Forgotten customers: each must vanish from default search on
  //     every angle that previously identified them (name, complaint
  //     object, payment object).
  //   - Retracted complaints: the complaint object string must NOT
  //     surface for the originating customer in default search.
  //   - Temporal-tier customers: the FINAL tier (platinum) is the
  //     one that surfaces; the staleTier (standard) does not.
  //
  // We probe a bounded slice (first 10) of each bucket to keep the
  // eval runtime bounded — the full bucket can be large at scale.
  const memoryAssertions: Scenario['memoryAssertions'] = [];
  const PROBE_LIMIT = 10;

  for (const fc of forgottenCustomers.slice(0, PROBE_LIMIT)) {
    memoryAssertions.push({
      description: `forgotten customer ${fc.id} no longer surfaces by name`,
      kind: 'no_search_match',
      query: fc.fullName,
      expectedRefAbsent: `fat.${fc.id}`,
    });
    if (fc.complaintObject) {
      memoryAssertions.push({
        description: `forgotten customer ${fc.id} no longer surfaces via complaint content`,
        kind: 'no_search_match',
        query: fc.complaintObject,
        expectedRefAbsent: `fat.${fc.id}`,
      });
    }
    if (fc.paymentObject) {
      memoryAssertions.push({
        description: `forgotten customer ${fc.id} no longer surfaces via payment-event content`,
        kind: 'no_search_match',
        query: fc.paymentObject,
        expectedRefAbsent: `fat.${fc.id}`,
      });
    }
  }

  for (const rc of retractedComplaints.slice(0, PROBE_LIMIT)) {
    memoryAssertions.push({
      description: `retracted complaint of ${rc.id} no longer surfaces in default search`,
      kind: 'search_object_absent',
      query: rc.object,
      expectedRefAbsent: `fat.${rc.id}`,
      objectSubstring: rc.object,
    });
  }

  for (const tc of temporalTierCustomers.slice(0, PROBE_LIMIT)) {
    memoryAssertions.push({
      description: `temporal-tier customer ${tc.id}: final tier surfaces in default search`,
      kind: 'search_object_present',
      query: `${tc.fullName} tier`,
      expectedRefPresent: `fat.${tc.id}`,
      objectSubstring: tc.finalTier,
    });
    memoryAssertions.push({
      description: `temporal-tier customer ${tc.id}: stale tier does NOT surface in default search`,
      kind: 'search_object_absent',
      query: `${tc.fullName} tier`,
      expectedRefAbsent: `fat.${tc.id}`,
      objectSubstring: tc.staleTier,
    });
  }

  // MIA / privacy-leakage test. Forgotten customer names are the
  // positives; we synthesise a same-size set of CONTROL names that
  // were never ingested. AUC ≤ 0.6 ⇒ regulator-defensible "model
  // has forgotten" — top-hit scores for forgotten names are
  // statistically indistinguishable from totally-novel names. We
  // bound to PROBE_LIMIT × 2 to keep the eval runtime sane.
  const forgottenForMia = forgottenCustomers.slice(0, PROBE_LIMIT * 2);
  const miaTests: Scenario['miaTests'] = [];
  if (forgottenForMia.length >= 2) {
    // Generate control names from the same name pool as the dataset
    // so the score distribution doesn't trivially differ on linguistic
    // shape (a "Smith" vs "Müller" prior would flag without leakage).
    // We just verify they're not in the forgotten set or the active
    // dataset to avoid accidental collisions.
    const usedNames = new Set([
      ...forgottenForMia.map((fc) => fc.fullName),
      // Active set: every customer that wasn't forgotten. We don't
      // want a "Maria Schmidt" control colliding with a still-active
      // "Maria Schmidt" customer — that's a false positive.
    ]);
    // To populate `usedNames` with the active customer names we'd
    // need to thread them through; for the MIA test the simpler
    // shape is to use names with a distinctive suffix that the
    // dataset can't have.
    const controlNames: string[] = [];
    let attempts = 0;
    while (controlNames.length < forgottenForMia.length && attempts < forgottenForMia.length * 10) {
      attempts++;
      const candidate = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)} Mia${attempts}`;
      if (!usedNames.has(candidate)) {
        controlNames.push(candidate);
        usedNames.add(candidate);
      }
    }
    if (controlNames.length === forgottenForMia.length) {
      miaTests.push({
        description: `forgotten ${forgottenForMia.length} customers vs control names — AUC must stay near 0.5 (no privacy leakage)`,
        forgottenNames: forgottenForMia.map((fc) => fc.fullName),
        controlNames,
        threshold: 0.6,
      });
    }
  }

  return {
    scenarios: [
      {
        id: 'fat-tenant.mid-scale',
        vertical: 'cross',
        description: `Fat-tenant fixture: ~${customerCount} customers + ${staffCount} staff + ${projectCount} projects, ~${factCount} facts. ${temporalTierCount} temporal-tier customers, ${competingStatusCount} competing-status, ${retractedComplaintCount} retracted complaints, ${forgottenCustomerCount} forgotten. Tests retrieval AND memory-lifecycle correctness at the scale where graph-aware techniques start to pay off.`,
        setup,
        queries,
        memoryAssertions,
        ...(miaTests.length > 0 ? { miaTests } : {}),
      },
    ],
    stats: {
      customers: customerCount,
      staff: staffCount,
      projects: projectCount,
      totalEntities: customerCount + staffCount + projectCount + 3,
      totalFacts: factCount,
      temporalTierCustomers: temporalTierCount,
      competingStatusCustomers: competingStatusCount,
      retractedComplaints: retractedComplaintCount,
      forgottenCustomers: forgottenCustomerCount,
    },
  };
}
