/**
 * The multi-domain corpus and check battery: turns about ONE shared
 * subject — "Meridian Clinic" — plus a person "Dr. Vega".
 *
 * SIX ontologies over one organisation, because that is what an
 * organisation is: the clinic has a payments arm (fintech), a clinical
 * side (medical), supplier agreements (legal), staff (hr), a
 * malpractice policy (insurance) and premises (real-estate). Every
 * first-party pack we ship is exercised here; four of them
 * (legal / hr / insurance / real-estate) were shipped and then run by
 * nothing at all until this battery grew to cover them.
 *
 * One conversation per domain, one generic (domain-free) conversation,
 * and one deliberately MIXED conversation weaving domains together, so
 * the entity's timeline genuinely interleaves their events in time
 * rather than stacking one domain entirely before another.
 *
 * Predicate ids are DERIVED from the real pack manifests at build time
 * (src/ai/domain-packs/*.pack.ts) through a guard that throws when a
 * referenced localId leaves the pack — the
 * corpus can never drift from the ontology it exercises. Turn
 * phrasing is chosen to hit those predicates' ADMIT rules:
 * fintech__licensed_as/"licensed as an EMI", medical__dosed_at/"dosed
 * at 500 mg twice daily", etc.
 *
 * Scoreability rules inherited from the siblings:
 *  - transition turns never restate the OLD value, so the history
 *    subsequence and the serve markers cannot cross-match;
 *  - every provenance fragment appears VERBATIM in exactly one turn,
 *    under the 600-char provenance text cap;
 *  - serve markers are value-shaped ("T+1", "850 mg") and never occur
 *    in decline phrasings.
 */
import { FINTECH_PACK } from '../../../src/ai/domain-packs/fintech.pack';
import { MEDICAL_PACK } from '../../../src/ai/domain-packs/medical.pack';
import { LEGAL_PACK } from '../../../src/ai/domain-packs/legal.pack';
import { HR_PACK } from '../../../src/ai/domain-packs/hr.pack';
import { INSURANCE_PACK } from '../../../src/ai/domain-packs/insurance.pack';
import { REAL_ESTATE_PACK } from '../../../src/ai/domain-packs/real-estate.pack';
import type { DomainPackManifest } from '../../../src/ai/domain-packs/manifest';
import type { Check, CorpusTurn, DomainSpec } from './types';

export { FINTECH_PACK, MEDICAL_PACK, LEGAL_PACK, HR_PACK, INSURANCE_PACK, REAL_ESTATE_PACK };

/**
 * Every pack the battery installs and exercises — the runner's phase 0
 * walks this, so adding a pack here is the whole wiring change.
 */
export const BATTERY_PACKS: DomainPackManifest[] = [
  FINTECH_PACK,
  MEDICAL_PACK,
  LEGAL_PACK,
  HR_PACK,
  INSURANCE_PACK,
  REAL_ESTATE_PACK,
];

/** The vertical every corpus write attributes itself to. */
export const CORPUS_VERTICAL = 'work';

/** The shared subject entity — one org, six domain ontologies. */
export const MERIDIAN_REF = { vertical: CORPUS_VERTICAL, id: 'org-meridian-clinic' } as const;
export const MERIDIAN_NAME = 'Meridian Clinic';

/** The person anchor entity. */
export const VEGA_REF = { vertical: CORPUS_VERTICAL, id: 'person-dr-vega' } as const;
export const VEGA_NAME = 'Dr. Vega';

/**
 * Namespaced pack predicate id, guarded against manifest drift: a
 * localId that leaves the pack makes the corpus refuse to build.
 */
export function packPredicate(pack: DomainPackManifest, localId: string): string {
  if (!pack.predicates.some((p) => p.localId === localId)) {
    throw new Error(
      `corpus references ${pack.id}__${localId}, which is not in ${pack.id}@${pack.version}`,
    );
  }
  return `${pack.id}__${localId}`;
}

/** Real fintech predicate ids (fintech@0.1.0). */
export const FIN = {
  licensed: packPredicate(FINTECH_PACK, 'licensed_as'),
  regulated: packPredicate(FINTECH_PACK, 'regulated_by'),
  complies: packPredicate(FINTECH_PACK, 'complies_with'),
  capital: packPredicate(FINTECH_PACK, 'capital_requirement'),
  settlement: packPredicate(FINTECH_PACK, 'settlement_period'),
} as const;

/** Real medical predicate ids (medical@0.1.0). */
export const MED = {
  treats: packPredicate(MEDICAL_PACK, 'treats'),
  dosed: packPredicate(MEDICAL_PACK, 'dosed_at'),
  route: packPredicate(MEDICAL_PACK, 'administered_via'),
  interacts: packPredicate(MEDICAL_PACK, 'interacts_with'),
} as const;

/** Real legal predicate ids (legal@0.1.0). */
export const LEG = {
  governed: packPredicate(LEGAL_PACK, 'governed_by'),
  party: packPredicate(LEGAL_PACK, 'party_to'),
  obligation: packPredicate(LEGAL_PACK, 'obligation'),
  terminates: packPredicate(LEGAL_PACK, 'terminates_on'),
} as const;

/** Real HR predicate ids (hr@0.1.0). */
export const HR = {
  skill: packPredicate(HR_PACK, 'requires_skill'),
  seniority: packPredicate(HR_PACK, 'seniority'),
  comp: packPredicate(HR_PACK, 'compensation'),
  location: packPredicate(HR_PACK, 'work_location'),
} as const;

/** Real insurance predicate ids (insurance@0.1.0). */
export const INS = {
  covers: packPredicate(INSURANCE_PACK, 'covers'),
  limit: packPredicate(INSURANCE_PACK, 'coverage_limit'),
  premium: packPredicate(INSURANCE_PACK, 'premium'),
  excludes: packPredicate(INSURANCE_PACK, 'excludes'),
} as const;

/** Real real-estate predicate ids (real_estate@0.1.0). */
export const RE = {
  zoned: packPredicate(REAL_ESTATE_PACK, 'zoned_as'),
  valued: packPredicate(REAL_ESTATE_PACK, 'valued_at'),
  tenure: packPredicate(REAL_ESTATE_PACK, 'tenure_type'),
  built: packPredicate(REAL_ESTATE_PACK, 'built_in'),
} as const;

/** Timestamp of turn N (1-based) — 5 minutes apart within a session. */
const t = (startIso: string, turn: number): string =>
  new Date(Date.parse(startIso) + (turn - 1) * 5 * 60_000).toISOString();

const conv = (conversation: string, startIso: string, texts: string[]): CorpusTurn[] =>
  texts.map((text, i) => ({ conversation, turn: i + 1, emittedAt: t(startIso, i + 1), text }));

// ── the conversations ───────────────────────────────────────────────
// One per domain, each ending in a single_active transition, spread
// across four days; mix (day 3) adds LATE events of the first two
// domains, so no domain sits entirely before another on the timeline.

/** Fintech conversation — hits licensed_as / regulated_by /
 *  complies_with / capital_requirement, then transitions
 *  settlement_period T+2 → T+1 (single_active). */
const FIN_TURNS = conv('fin', '2026-08-31T09:00:00Z', [
  'Meridian Clinic runs its own payments arm and is licensed as an EMI.',
  "Meridian Clinic's payments arm is regulated by the FCA.",
  "Meridian Clinic's payment gateway is PCI-DSS compliant.",
  'Meridian Clinic must hold €2M in own funds as its capital requirement.',
  "Meridian Clinic's card settlements settle T+2.",
  "Since this week, Meridian Clinic's card settlements settle T+1.",
]);

/** Medical conversation — hits treats / administered_via, then
 *  transitions dosed_at 500 mg → 850 mg (single_active). */
const MED_TURNS = conv('med', '2026-08-31T14:00:00Z', [
  'Meridian Clinic treats type 2 diabetes in its outpatient program.',
  'Dr. Vega runs the infusion unit at Meridian Clinic.',
  "Meridian Clinic's antibiotic therapy is administered via intravenous infusion.",
  "Meridian Clinic's standard metformin course is dosed at 500 mg twice daily.",
  'Meridian Clinic revised its standard metformin course: it is now dosed at 850 mg twice daily.',
  'Meridian Clinic treats hypertension in its cardiology wing.',
]);

/** Generic conversation — domain-free turns about the SAME entity. */
const GEN_TURNS = conv('gen', '2026-09-01T10:00:00Z', [
  'Meridian Clinic was founded in 2009.',
  'Meridian Clinic is headquartered in Lisbon.',
  'Dr. Vega has worked at Meridian Clinic since 2019.',
  'Dr. Vega specializes in endocrinology.',
]);

/** Mixed conversation — both domains inside ONE conversation, and the
 *  LATE event of each domain (the interleave anchors). */
const MIX_TURNS = conv('mix', '2026-09-02T11:00:00Z', [
  "Dr. Vega reported that Meridian Clinic's warfarin protocol interacts with aspirin.",
  "Meridian Clinic's payments arm passed its audit — the gateway complies with SOC 2.",
  "Meridian Clinic's oncology unit administers rituximab via intravenous infusion.",
  "Meridian Clinic's payment gateway also meets KYC requirements.",
]);

/** Legal conversation — governed_by / party_to / obligation, then
 *  transitions terminates_on 2027-03-31 → 2028-03-31 (single_active). */
const LEG_TURNS = conv('leg', '2026-09-01T09:00:00Z', [
  "Meridian Clinic's supplier agreement with Northwind Labs is governed by English law.",
  'Northwind Labs is a party to the Meridian Clinic supplier agreement.',
  'Under that agreement Meridian Clinic has an obligation to give 90 days notice before cancelling an order.',
  "Meridian Clinic's supplier agreement terminates on 2027-03-31.",
  'The parties extended it: the supplier agreement now terminates on 2028-03-31.',
]);

/** HR conversation — requires_skill / work_location, then transitions
 *  compensation 62000 → 68000 (single_active). */
const HR_TURNS = conv('hr', '2026-09-01T14:00:00Z', [
  'The Meridian Clinic infusion nurse role requires ACLS certification.',
  'That infusion nurse role is a Senior position.',
  // Deliberately NOT "Lisbon": that token is a GENERIC_MARKER, and the
  // cross-entity check proves generic facts attach to the shared entity
  // by finding one. A second home for the token would let an HR fact
  // satisfy that evidence and quietly weaken the check.
  'The infusion nurse role is based at the Alfama site as its work location.',
  'The infusion nurse role has compensation of 62000 EUR per year.',
  'After the pay review the infusion nurse role has compensation of 68000 EUR per year.',
]);

/** Insurance conversation — covers / excludes, then transitions
 *  coverage_limit 5M → 8M (single_active). */
const INS_TURNS = conv('ins', '2026-09-02T09:00:00Z', [
  "Meridian Clinic's malpractice policy covers clinical negligence claims.",
  'That malpractice policy excludes cosmetic procedures.',
  "Meridian Clinic's malpractice policy has a premium of 47000 EUR a year.",
  "Meridian Clinic's malpractice policy has a coverage limit of 5M EUR.",
  'At renewal the malpractice policy has a coverage limit of 8M EUR.',
]);

/** Real-estate conversation — valued_at / built_in, then transitions
 *  zoned_as mixed-use → healthcare (single_active). */
const RE_TURNS = conv('re', '2026-09-02T14:00:00Z', [
  'The Meridian Clinic building on Rua do Ouro was built in 1998.',
  'Meridian Clinic holds the Rua do Ouro premises on a leasehold tenure.',
  'The Rua do Ouro premises were valued at 4.2M EUR at the last survey.',
  'The Rua do Ouro premises are zoned as mixed-use.',
  'The council rezoned it: the Rua do Ouro premises are now zoned as healthcare.',
]);

export const ALL_TURNS: CorpusTurn[] = [
  ...FIN_TURNS,
  ...MED_TURNS,
  ...LEG_TURNS,
  ...HR_TURNS,
  ...INS_TURNS,
  ...RE_TURNS,
  ...GEN_TURNS,
  ...MIX_TURNS,
];

// ── domain lenses ───────────────────────────────────────────────────
// Markers are corpus VALUES (regulators, standards, doses, drugs) —
// never generic words — so a fact matches its domain by content even
// while extraction still coins open-vocab predicates.

export const FIN_DOMAIN: DomainSpec = {
  namespace: FINTECH_PACK.id,
  markers: ['EMI', 'FCA', 'PCI-DSS', 'T+2', 'T+1', 'own funds', 'SOC 2', 'KYC'],
};

export const MED_DOMAIN: DomainSpec = {
  namespace: MEDICAL_PACK.id,
  markers: [
    'diabetes',
    'metformin',
    'hypertension',
    'intravenous',
    'infusion',
    'warfarin',
    'aspirin',
    'rituximab',
  ],
};

export const LEG_DOMAIN: DomainSpec = {
  namespace: LEGAL_PACK.id,
  markers: ['English law', 'Northwind', '90 days notice', '2027-03-31', '2028-03-31'],
};

export const HR_DOMAIN: DomainSpec = {
  namespace: HR_PACK.id,
  markers: ['ACLS', 'Senior', '62000', '68000'],
};

export const INS_DOMAIN: DomainSpec = {
  namespace: INSURANCE_PACK.id,
  markers: ['clinical negligence', 'cosmetic procedures', '47000', '5M EUR', '8M EUR'],
};

export const RE_DOMAIN: DomainSpec = {
  namespace: REAL_ESTATE_PACK.id,
  markers: ['Rua do Ouro', '1998', 'leasehold', '4.2M', 'mixed-use', 'healthcare'],
};

/** Markers of the generic (domain-free) turns. */
export const GENERIC_MARKERS = ['2009', 'Lisbon', 'founded', 'headquartered'];

// ── the checks ──────────────────────────────────────────────────────

const VOCAB_BASELINE =
  'Outcome never measured: mention extraction may not consult the installed ' +
  "pack's extractionProfile on this path yet, so a coined open-vocab " +
  'predicate here is the baseline finding this battery exists to record.';

export const CHECKS: Check[] = [
  // ── install ───────────────────────────────────────────────────────
  {
    kind: 'install',
    id: 'c01-install',
    cls: 'setup',
    intent: 'Both industry packs are actually installed in the tenant after phase 0.',
    packs: BATTERY_PACKS.map((pack) => ({ packId: pack.id, version: pack.version })),
  },

  // ── pack-vocab (2 per domain, honest baseline) ────────────────────
  {
    kind: 'pack-vocab',
    id: 'c02-vocab-fin-licensed',
    cls: 'vocab',
    intent: `"licensed as an EMI" canonicalizes into ${FIN.licensed}, not a coined predicate.`,
    searchQuery: 'Meridian Clinic EMI license',
    predicate: FIN.licensed,
    valueMarkers: ['EMI'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c03-vocab-fin-settlement',
    cls: 'vocab',
    intent: `the settlement window lands on ${FIN.settlement} with a verbatim T+n value.`,
    searchQuery: 'Meridian Clinic card settlement period',
    predicate: FIN.settlement,
    valueMarkers: ['T+1', 'T+2'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c04-vocab-med-treats',
    cls: 'vocab',
    intent: `a treated condition lands on ${MED.treats} with the verbatim condition.`,
    searchQuery: 'Meridian Clinic diabetes treatment',
    predicate: MED.treats,
    valueMarkers: ['diabetes', 'hypertension'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c05-vocab-med-dosed',
    cls: 'vocab',
    intent: `the metformin dose lands on ${MED.dosed} with the verbatim dose.`,
    searchQuery: 'Meridian Clinic metformin dose',
    predicate: MED.dosed,
    valueMarkers: ['850 mg', '500 mg'],
    expectedUnknown: VOCAB_BASELINE,
  },

  // ── pack-transition (1 per domain) ────────────────────────────────
  {
    kind: 'pack-transition',
    id: 'c06-transition-fin',
    cls: 'transition',
    intent: 'The settlement transition retains T+2 → T+1 as ordered history.',
    searchQuery: 'Meridian Clinic card settlement',
    stages: [['T+2'], ['T+1']],
  },
  {
    kind: 'pack-transition',
    id: 'c07-transition-med',
    cls: 'transition',
    intent: 'The dosing transition retains 500 mg → 850 mg as ordered history.',
    searchQuery: 'Meridian Clinic metformin course',
    stages: [['500 mg'], ['850 mg']],
  },

  // ── cross-domain entity ───────────────────────────────────────────
  {
    kind: 'cross-entity',
    id: 'c08-cross-entity',
    cls: 'cross-domain',
    intent:
      'ONE Meridian Clinic entity carries fintech + medical + generic facts — ' +
      'no per-domain entity duplication.',
    searchQuery: 'Meridian Clinic',
    entityNameToken: 'meridian',
    domains: [FIN_DOMAIN, MED_DOMAIN, LEG_DOMAIN, HR_DOMAIN, INS_DOMAIN, RE_DOMAIN],
    genericMarkers: GENERIC_MARKERS,
  },

  // ── cross-domain trace ────────────────────────────────────────────
  {
    kind: 'trace-provenance',
    id: 'c09-trace-fin',
    cls: 'trace',
    intent: "A fintech fact unrolls to the fintech conversation's seeded turn.",
    searchQuery: 'Meridian Clinic EMI license',
    objectHint: ['EMI'],
    episodeFragments: ['licensed as an EMI'],
  },
  {
    kind: 'trace-provenance',
    id: 'c10-trace-med',
    cls: 'trace',
    intent: "A medical fact unrolls to the medical conversation's seeded turn.",
    searchQuery: 'Meridian Clinic type 2 diabetes',
    objectHint: ['diabetes'],
    episodeFragments: ['treats type 2 diabetes'],
  },
  {
    kind: 'trace-interleave',
    id: 'c11-trace-interleave',
    cls: 'trace',
    intent:
      "The shared entity's timeline holds events of BOTH domains and neither " +
      'domain sits entirely before the other in time.',
    searchQuery: 'Meridian Clinic',
    entityNameToken: 'meridian',
    domains: [FIN_DOMAIN, MED_DOMAIN, LEG_DOMAIN, HR_DOMAIN, INS_DOMAIN, RE_DOMAIN],
  },

  // ── serving ───────────────────────────────────────────────────────
  {
    kind: 'serve-cross',
    id: 'c12-serve-cross',
    cls: 'serving',
    intent: 'A broad question about the entity serves facts from BOTH domains.',
    query: 'Tell me about Meridian Clinic.',
    requireGroups: [
      ['EMI', 'FCA', 'PCI-DSS', 'T+1', 'T+2', 'SOC 2', 'KYC', '€2M'],
      ['diabetes', 'metformin', 'hypertension', 'intravenous', 'warfarin', 'rituximab', '850 mg'],
    ],
  },
  {
    kind: 'serve-isolation',
    id: 'c13-isolation-fin',
    cls: 'serving',
    intent: 'A fintech question answers from the fintech fact, no medical confabulation.',
    query: 'What settlement period do Meridian Clinic card settlements use?',
    expectAnyOf: ['T+1'],
    forbidAnyOf: ['metformin', '850 mg', '500 mg', 'diabetes', 'warfarin', 'intravenous'],
  },
  {
    kind: 'serve-isolation',
    id: 'c14-isolation-med',
    cls: 'serving',
    intent: 'A medical question answers from the medical fact, no fintech confabulation.',
    query: "What is the dose of Meridian Clinic's standard metformin course?",
    expectAnyOf: ['850'],
    forbidAnyOf: ['T+1', 'T+2', 'EMI', 'FCA', 'PCI-DSS', 'SOC 2', '€2M'],
  },

  // ── the four packs nothing exercised until now ────────────────────
  // Same shape per domain as fintech/medical above: two vocab checks
  // (one plain, one on the value that transitions), one transition, one
  // provenance unroll, one isolation serve.
  {
    kind: 'pack-vocab',
    id: 'c16-vocab-leg-governed',
    cls: 'vocab',
    intent: `the governing law lands on ${LEG.governed} with the verbatim jurisdiction.`,
    searchQuery: 'Meridian Clinic supplier agreement governing law',
    predicate: LEG.governed,
    valueMarkers: ['English law'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c17-vocab-leg-terminates',
    cls: 'vocab',
    intent: `the termination date lands on ${LEG.terminates} with a verbatim date.`,
    searchQuery: 'Meridian Clinic supplier agreement termination date',
    predicate: LEG.terminates,
    valueMarkers: ['2027-03-31', '2028-03-31'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c18-vocab-hr-skill',
    cls: 'vocab',
    intent: `a required qualification lands on ${HR.skill} with the verbatim skill.`,
    searchQuery: 'Meridian Clinic infusion nurse required certification',
    predicate: HR.skill,
    valueMarkers: ['ACLS'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c19-vocab-hr-comp',
    cls: 'vocab',
    intent: `the pay figure lands on ${HR.comp} with the verbatim amount.`,
    searchQuery: 'Meridian Clinic infusion nurse compensation',
    predicate: HR.comp,
    valueMarkers: ['62000', '68000'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c20-vocab-ins-covers',
    cls: 'vocab',
    intent: `the covered peril lands on ${INS.covers} with the verbatim claim class.`,
    searchQuery: 'Meridian Clinic malpractice policy coverage',
    predicate: INS.covers,
    valueMarkers: ['clinical negligence'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c21-vocab-ins-limit',
    cls: 'vocab',
    intent: `the coverage ceiling lands on ${INS.limit} with the verbatim amount.`,
    searchQuery: 'Meridian Clinic malpractice policy coverage limit',
    predicate: INS.limit,
    valueMarkers: ['5M', '8M'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c22-vocab-re-tenure',
    cls: 'vocab',
    intent: `the tenure lands on ${RE.tenure} with the verbatim tenure type.`,
    searchQuery: 'Meridian Clinic Rua do Ouro tenure',
    predicate: RE.tenure,
    valueMarkers: ['leasehold'],
    expectedUnknown: VOCAB_BASELINE,
  },
  {
    kind: 'pack-vocab',
    id: 'c23-vocab-re-zoned',
    cls: 'vocab',
    intent: `the zoning lands on ${RE.zoned} with the verbatim designation.`,
    searchQuery: 'Meridian Clinic Rua do Ouro zoning',
    predicate: RE.zoned,
    valueMarkers: ['mixed-use', 'healthcare'],
    expectedUnknown: VOCAB_BASELINE,
  },

  {
    kind: 'pack-transition',
    id: 'c24-transition-leg',
    cls: 'transition',
    intent: 'The extension retains 2027-03-31 → 2028-03-31 as ordered history.',
    searchQuery: 'Meridian Clinic supplier agreement termination',
    stages: [['2027-03-31'], ['2028-03-31']],
  },
  {
    kind: 'pack-transition',
    id: 'c25-transition-hr',
    cls: 'transition',
    intent: 'The pay review retains 62000 → 68000 as ordered history.',
    searchQuery: 'Meridian Clinic infusion nurse compensation',
    stages: [['62000'], ['68000']],
  },
  {
    kind: 'pack-transition',
    id: 'c26-transition-ins',
    cls: 'transition',
    intent: 'The renewal retains the 5M → 8M coverage limit as ordered history.',
    searchQuery: 'Meridian Clinic malpractice coverage limit',
    stages: [['5M'], ['8M']],
  },
  {
    kind: 'pack-transition',
    id: 'c27-transition-re',
    cls: 'transition',
    intent: 'The rezoning retains mixed-use → healthcare as ordered history.',
    searchQuery: 'Meridian Clinic Rua do Ouro zoning',
    stages: [['mixed-use'], ['healthcare']],
  },

  {
    kind: 'trace-provenance',
    id: 'c28-trace-leg',
    cls: 'trace',
    intent: "A legal fact unrolls to the legal conversation's seeded turn.",
    searchQuery: 'Meridian Clinic supplier agreement governing law',
    objectHint: ['English law'],
    episodeFragments: ['governed by English law'],
  },
  {
    kind: 'trace-provenance',
    id: 'c29-trace-hr',
    cls: 'trace',
    intent: "An HR fact unrolls to the HR conversation's seeded turn.",
    searchQuery: 'Meridian Clinic infusion nurse certification',
    objectHint: ['ACLS'],
    episodeFragments: ['requires ACLS certification'],
  },
  {
    kind: 'trace-provenance',
    id: 'c30-trace-ins',
    cls: 'trace',
    intent: "An insurance fact unrolls to the insurance conversation's seeded turn.",
    searchQuery: 'Meridian Clinic malpractice exclusions',
    objectHint: ['cosmetic'],
    episodeFragments: ['excludes cosmetic procedures'],
  },
  {
    kind: 'trace-provenance',
    id: 'c31-trace-re',
    cls: 'trace',
    intent: "A real-estate fact unrolls to the real-estate conversation's seeded turn.",
    searchQuery: 'Meridian Clinic Rua do Ouro build year',
    objectHint: ['1998'],
    episodeFragments: ['built in 1998'],
  },

  // Isolation across SIX ontologies is the check the two-pack battery
  // could not make: an answer about premises must not reach for the
  // clinical, financial, legal, staffing or policy facts of the same
  // organisation just because they share an entity.
  {
    kind: 'serve-isolation',
    id: 'c32-isolation-leg',
    cls: 'serving',
    intent: 'A legal question answers from the legal fact, with no other domain bleeding in.',
    query: "What law governs Meridian Clinic's supplier agreement with Northwind Labs?",
    expectAnyOf: ['English'],
    forbidAnyOf: ['metformin', 'T+1', 'ACLS', '68000', 'leasehold', 'clinical negligence'],
  },
  {
    kind: 'serve-isolation',
    id: 'c33-isolation-hr',
    cls: 'serving',
    intent: 'An HR question answers from the HR fact, with no other domain bleeding in.',
    query: 'What is the compensation for the Meridian Clinic infusion nurse role?',
    expectAnyOf: ['68000'],
    forbidAnyOf: ['metformin', 'T+1', 'English law', 'leasehold', '8M'],
  },
  {
    kind: 'serve-isolation',
    id: 'c34-isolation-ins',
    cls: 'serving',
    intent:
      'An insurance question answers from the insurance fact, with no other domain bleeding in.',
    query: "What is the coverage limit on Meridian Clinic's malpractice policy?",
    expectAnyOf: ['8M'],
    forbidAnyOf: ['metformin', 'T+1', 'ACLS', 'English law', 'leasehold'],
  },
  {
    kind: 'serve-isolation',
    id: 'c35-isolation-re',
    cls: 'serving',
    intent:
      'A real-estate question answers from the real-estate fact, with no other domain bleeding in.',
    query: 'How are the Meridian Clinic Rua do Ouro premises zoned?',
    expectAnyOf: ['healthcare'],
    forbidAnyOf: ['metformin', 'T+1', 'ACLS', '68000', '8M'],
  },

  // ── surfaces ──────────────────────────────────────────────────────
  {
    kind: 'no-rogue-tools',
    id: 'c15-no-rogue-tools',
    cls: 'surfaces',
    intent:
      'Neither installed pack declares mcpTools, so tools/list must carry ZERO ' +
      '__-namespaced pack tools — the no-op is asserted, not assumed.',
  },
];
