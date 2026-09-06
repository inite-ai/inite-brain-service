/**
 * The multi-domain corpus and check battery: ~20 turns about ONE
 * shared subject — "Meridian Clinic", an org that is BOTH a fintech
 * client (its payments arm) and a medical provider (its clinical
 * side) — plus a person "Dr. Vega". One conversation per domain, one
 * generic (domain-free) conversation, and one deliberately MIXED
 * conversation weaving both domains, so the entity's timeline
 * genuinely interleaves fintech and medical events in time.
 *
 * Predicate ids are DERIVED from the real pack manifests at build
 * time (src/ai/domain-packs/{fintech,medical}.pack.ts) through a
 * guard that throws when a referenced localId leaves the pack — the
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
import type { DomainPackManifest } from '../../../src/ai/domain-packs/manifest';
import type { Check, CorpusTurn, DomainSpec } from './types';

export { FINTECH_PACK, MEDICAL_PACK };

/** The vertical every corpus write attributes itself to. */
export const CORPUS_VERTICAL = 'work';

/** The shared subject entity — one org, two domain ontologies. */
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

/** Timestamp of turn N (1-based) — 5 minutes apart within a session. */
const t = (startIso: string, turn: number): string =>
  new Date(Date.parse(startIso) + (turn - 1) * 5 * 60_000).toISOString();

const conv = (conversation: string, startIso: string, texts: string[]): CorpusTurn[] =>
  texts.map((text, i) => ({ conversation, turn: i + 1, emittedAt: t(startIso, i + 1), text }));

// ── the four conversations ──────────────────────────────────────────
// fin (day 1 morning) and med (day 1 afternoon) each end in a
// transition; mix (day 3) adds LATE events of both domains, so
// neither domain sits entirely before the other on the timeline.

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

export const ALL_TURNS: CorpusTurn[] = [...FIN_TURNS, ...MED_TURNS, ...GEN_TURNS, ...MIX_TURNS];

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
    packs: [
      { packId: FINTECH_PACK.id, version: FINTECH_PACK.version },
      { packId: MEDICAL_PACK.id, version: MEDICAL_PACK.version },
    ],
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
    domains: [FIN_DOMAIN, MED_DOMAIN],
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
    domains: [FIN_DOMAIN, MED_DOMAIN],
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
