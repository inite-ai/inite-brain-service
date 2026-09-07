import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: insurance. DISTRIBUTABLE (installed per-tenant from
 * `packs/insurance.pack.json`, NOT in BUILTIN_PACKS). Captures policy ontology —
 * coverage, limits, premiums, deductibles, exclusions — with an extractionProfile
 * + eval fixtures + memoryModel (policy / claim lifecycles, attention +
 * retention hints, recency rules for premium and coverage claims).
 *
 * As of 0.3.0 the memoryModel also carries a MEDIA CONTRACT: claim
 * photographs and policy documents as input modalities, the two core
 * capabilities the Evidence Plane can actually run (image metadata,
 * document text), and NO raw-evidence declaration — a claim photo
 * routinely carries third-party personal data.
 *
 * Bump `version` to ship an update.
 */
export const INSURANCE_PACK: DomainPackManifest = {
  id: 'insurance',
  version: '0.3.0',
  description:
    'Insurance ontology — coverage, limits, premiums, deductibles, and exclusions of policies, with a domain extraction profile and memory model.',
  predicates: [
    {
      localId: 'covers',
      displayLabel: 'covers',
      description: `TYPE   subject is a policy; value is a covered peril/loss
ADMIT  text states what the policy covers ("covers water damage",
       "includes third-party liability")
VALUE  one covered item per fact, verbatim ("water damage")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'coverage_limit',
      displayLabel: 'coverage limit',
      description: `TYPE   subject is a policy; value is a coverage limit/sum insured
ADMIT  text states a limit or sum insured ("limit of $1,000,000",
       "sum insured £250k")
VALUE  the amount, verbatim including currency ("$1,000,000")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'premium',
      displayLabel: 'premium',
      description: `TYPE   subject is a policy; value is a premium
ADMIT  text states the premium ("annual premium of $1,200",
       "$100/month")
VALUE  the premium amount, verbatim ("$1,200/year")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'deductible',
      displayLabel: 'deductible',
      description: `TYPE   subject is a policy; value is a deductible/excess
ADMIT  text states the deductible or excess ("$500 deductible",
       "£250 excess")
VALUE  the amount, verbatim ("$500")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'excludes',
      displayLabel: 'excludes',
      description: `TYPE   subject is a policy; value is an exclusion
ADMIT  text states what is NOT covered ("excludes flood", "war and
       terrorism excluded")
VALUE  one exclusion per fact, verbatim ("flood")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Insurance inputs describe POLICIES. Treat the named policy/product
as the SUBJECT entity. Prefer the insurance__* predicates for covered perils
(insurance__covers), limits (insurance__coverage_limit), premiums
(insurance__premium), deductibles (insurance__deductible), and exclusions
(insurance__excludes). Copy amounts and peril names VERBATIM — "$1,000,000" not
"a million", "flood" not "water event". Distinguish what the policy COVERS from
what it EXCLUDES.`,
    fewShot: [
      {
        text: 'The Home Plus policy covers fire and theft with a $500 deductible; flood is excluded.',
        note: "policy 'Home Plus' → insurance__covers='fire', insurance__covers='theft', insurance__deductible='$500', insurance__excludes='flood'.",
      },
      {
        text: 'Annual premium of $1,200 with a coverage limit of $1,000,000.',
        note: "→ insurance__premium='$1,200', insurance__coverage_limit='$1,000,000'.",
      },
    ],
  },
  // The domain perception contract (docs/domain-packs.md). Declarative data
  // only — consumed by MemoryModelReaderService for installed tenants.
  // The media section (modalities/processors/rawEvidence) is the consent
  // surface: installing this pack requires `acceptModalities: true`.
  memoryModel: {
    sceneSchemas: [
      {
        id: 'claim_intake',
        description:
          'A claim intake: a loss event is reported against a policy and first notice of loss details are captured.',
        cues: ['claim', 'first notice of loss', 'loss reported', 'incident'],
      },
      {
        id: 'renewal_review',
        description:
          'A policy renewal or re-quote: terms, premium, and coverage of an existing policy are reassessed.',
        cues: ['renewal', 'requote', 'premium change', 'rate increase'],
      },
    ],
    stateModels: [
      {
        id: 'policy_lifecycle',
        subjectType: 'policy',
        states: ['quoted', 'bound', 'renewed', 'lapsed', 'cancelled'],
        transitions: [
          { from: 'quoted', to: 'bound' },
          { from: 'bound', to: 'renewed' },
          { from: 'renewed', to: 'renewed' },
          { from: 'bound', to: 'lapsed' },
          { from: 'renewed', to: 'lapsed' },
          { from: 'bound', to: 'cancelled' },
          { from: 'renewed', to: 'cancelled' },
          { from: 'lapsed', to: 'bound' },
        ],
      },
      {
        id: 'claim_lifecycle',
        subjectType: 'claim',
        states: ['reported', 'assessed', 'approved', 'denied', 'paid', 'closed'],
        transitions: [
          { from: 'reported', to: 'assessed' },
          { from: 'assessed', to: 'approved' },
          { from: 'assessed', to: 'denied' },
          { from: 'approved', to: 'paid' },
          { from: 'paid', to: 'closed' },
          { from: 'denied', to: 'closed' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'covers', prefer: ['covers'], zoom: ['facts'], weight: 0.6 },
      { cue: 'excluded', prefer: ['excludes'], zoom: ['facts'], weight: 0.7 },
      { cue: 'deductible', prefer: ['deductible'], zoom: ['facts'], weight: 0.6 },
      { cue: 'excess', prefer: ['deductible'], zoom: ['facts'], weight: 0.5 },
      { cue: 'premium', prefer: ['premium'], zoom: ['facts'], weight: 0.6 },
      { cue: 'sum insured', prefer: ['coverage_limit'], zoom: ['facts'], weight: 0.6 },
      {
        cue: 'claim',
        prefer: ['covers', 'excludes', 'deductible'],
        zoom: ['claim_intake', 'episodes'],
        weight: 0.7,
      },
    ],
    // Premiums and coverage terms are repriced and rewritten at every
    // renewal — serve both recency-checked.
    verificationRules: [
      { claimPattern: 'premium', requires: 'recency_check' },
      { claimPattern: 'cover', requires: 'recency_check' },
    ],
    retentionHints: [
      { predicateOrScene: 'covers', hint: 'durable' },
      { predicateOrScene: 'excludes', hint: 'durable' },
      { predicateOrScene: 'coverage_limit', hint: 'durable' },
      { predicateOrScene: 'premium', hint: 'standard' },
      { predicateOrScene: 'deductible', hint: 'standard' },
      { predicateOrScene: 'claim_intake', hint: 'durable' },
      { predicateOrScene: 'renewal_review', hint: 'standard' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // A claim arrives as PHOTOGRAPHS of the loss and as POLICY DOCUMENTS
    // (schedules, wordings, adjuster reports). Only the two capabilities
    // the trusted core can actually run today are requested: image
    // metadata (image → caption) and document text extraction
    // (document → text). OCR / ASR / vision-caption are deliberately NOT
    // declared — no adapter is installed for them.
    modalities: ['text', 'image', 'document'],
    processors: [
      { id: 'image_metadata', modality: 'image', produces: ['caption'] },
      { id: 'document_text', modality: 'document', produces: ['text'] },
    ],
    // rawEvidence is DELIBERATELY ABSENT (omission = deny). Claim
    // photography routinely captures injuries, plates, and bystanders —
    // third-party personal data the pack has no standing to hand back —
    // so gateRawEvidence refuses raw bytes and signed URLs for this pack.
  },
  evalFixtures: [
    {
      id: 'coverage',
      description: 'a covered peril is extracted',
      text: 'The policy covers fire damage.',
      expect: { facts: [{ predicate: 'covers', objectIncludes: 'fire' }] },
    },
    {
      id: 'deductible',
      description: 'the deductible is captured verbatim',
      text: 'This policy has a $500 deductible.',
      expect: { facts: [{ predicate: 'deductible', objectIncludes: '$500' }] },
    },
    {
      id: 'exclusion',
      description: 'an exclusion is captured',
      text: 'Flood is excluded from this policy.',
      expect: { facts: [{ predicate: 'excludes', objectIncludes: 'Flood' }] },
    },
    {
      id: 'limit',
      description: 'the coverage limit is captured verbatim with currency',
      text: 'The policy has a coverage limit of $1,000,000.',
      expect: { facts: [{ predicate: 'coverage_limit', objectIncludes: '$1,000,000' }] },
    },
    {
      id: 'premium',
      description: 'the premium is captured verbatim',
      text: 'The annual premium is $1,200.',
      expect: { facts: [{ predicate: 'premium', objectIncludes: '$1,200' }] },
    },
  ],
};
