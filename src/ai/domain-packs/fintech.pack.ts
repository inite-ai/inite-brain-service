import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: fintech / financial-services regulation. Like
 * real-estate (and unlike the builtin code-memory), a DISTRIBUTABLE pack —
 * installed per-tenant from `packs/fintech.pack.json` via `pnpm pack:install`,
 * NOT in BUILTIN_PACKS, so its domain predicates don't seed into unrelated
 * tenants. Ships an extractionProfile + eval fixtures + memoryModel (license /
 * certification / enforcement lifecycles, attention + retention hints, recency
 * rules for license and settlement claims) so it's a complete, self-verifying
 * ontology, not a stub.
 *
 * As of 0.3.0 the memoryModel also carries a MEDIA CONTRACT: statements,
 * filings, and KYC paperwork as documents; document text extraction as the
 * single core capability requested; NO image modality (KYC identity
 * photography is biometric-adjacent) and NO raw-evidence declaration.
 *
 * Bump `version` to ship an update.
 */
export const FINTECH_PACK: DomainPackManifest = {
  id: 'fintech',
  version: '0.3.0',
  description:
    'Financial-services regulation ontology — regulators, licenses, compliance standards, capital, and settlement of institutions/products, with a domain extraction profile and memory model.',
  predicates: [
    {
      localId: 'regulated_by',
      displayLabel: 'regulated by',
      description: `TYPE   subject is an institution/product; value is a regulator
ADMIT  text names the authority that regulates the subject ("regulated
       by the FCA", "under SEC oversight")
VALUE  the regulator, verbatim ("FCA", "SEC", "MAS")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'licensed_as',
      displayLabel: 'licensed as',
      description: `TYPE   subject is an institution; value is a license/registration type
ADMIT  text states the license or registration the subject holds
       ("licensed as an EMI", "registered broker-dealer")
VALUE  the license/registration term, verbatim ("EMI", "broker-dealer")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'complies_with',
      displayLabel: 'complies with',
      description: `TYPE   subject is an institution/product; value is a standard/regulation
ADMIT  text states a named standard or regulation the subject meets
       ("PCI-DSS compliant", "meets KYC/AML", "SOC 2 Type II")
VALUE  one standard per fact, verbatim ("PCI-DSS", "KYC", "SOC 2")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'capital_requirement',
      displayLabel: 'capital requirement',
      description: `TYPE   subject is an institution; value is a required capital/reserve
ADMIT  text states a regulatory capital or reserve requirement
       ("must hold €5M in own funds", "20% reserve requirement")
VALUE  the amount, verbatim including currency/percent ("€5M", "20%")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'settlement_period',
      displayLabel: 'settlement period',
      description: `TYPE   subject is an instrument/transaction; value is a settlement window
ADMIT  text states the settlement period ("settles T+2", "same-day
       settlement")
VALUE  the settlement term, verbatim ("T+2", "same-day")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Financial-services inputs describe institutions, products, or
transactions. Treat the named institution / product / instrument as the SUBJECT
entity. Prefer the fintech__* predicates for
regulators (fintech__regulated_by), licenses (fintech__licensed_as), compliance
standards (fintech__complies_with), capital/reserve requirements
(fintech__capital_requirement), and settlement windows
(fintech__settlement_period). Copy regulator acronyms, license terms, standards,
amounts, and settlement terms VERBATIM — "FCA" not "the regulator", "PCI-DSS"
not "card standard", "T+2" not "two days". When a regulator or auditor is a
named entity, ALSO emit an edge (Institution —regulated_by→ Authority).`,
    fewShot: [
      {
        text: 'Acme Pay is an EMI regulated by the FCA and is PCI-DSS compliant.',
        note: "org 'Acme Pay' → fintech__licensed_as='EMI', fintech__regulated_by='FCA', fintech__complies_with='PCI-DSS'; edge (Acme Pay, regulated_by, FCA).",
      },
      {
        text: 'The fund must hold €5M in own funds; trades settle T+2.',
        note: "→ fintech__capital_requirement='€5M', fintech__settlement_period='T+2'.",
      },
      {
        text: 'Nova Securities is a registered broker-dealer under SEC oversight.',
        note: "org 'Nova Securities' → fintech__licensed_as='broker-dealer', fintech__regulated_by='SEC'.",
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
        id: 'audit_review',
        description:
          'A compliance audit or regulatory examination: an auditor or regulator reviews the institution and findings are discussed.',
        cues: ['audit', 'examination', 'regulator visit', 'findings'],
      },
      {
        id: 'regulatory_filing',
        description:
          'A regulatory filing or reporting event: the institution submits returns, disclosures, or capital reports to its regulator.',
        cues: ['filing', 'submitted', 'annual return', 'disclosure'],
      },
    ],
    stateModels: [
      {
        id: 'license_lifecycle',
        subjectType: 'license',
        states: ['applied', 'granted', 'suspended', 'revoked', 'surrendered'],
        transitions: [
          { from: 'applied', to: 'granted' },
          { from: 'granted', to: 'suspended' },
          { from: 'suspended', to: 'granted' },
          { from: 'granted', to: 'revoked' },
          { from: 'suspended', to: 'revoked' },
          { from: 'granted', to: 'surrendered' },
        ],
      },
      {
        id: 'certification_lifecycle',
        subjectType: 'compliance_certification',
        states: ['in_assessment', 'certified', 'lapsed', 'withdrawn'],
        transitions: [
          { from: 'in_assessment', to: 'certified' },
          { from: 'certified', to: 'lapsed' },
          { from: 'lapsed', to: 'in_assessment' },
          { from: 'certified', to: 'withdrawn' },
        ],
      },
      {
        id: 'enforcement_lifecycle',
        subjectType: 'enforcement_action',
        states: ['opened', 'remediation_ordered', 'settled', 'closed'],
        transitions: [
          { from: 'opened', to: 'remediation_ordered' },
          { from: 'remediation_ordered', to: 'settled' },
          { from: 'opened', to: 'settled' },
          { from: 'settled', to: 'closed' },
          { from: 'opened', to: 'closed' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'regulated by', prefer: ['regulated_by'], zoom: ['facts'], weight: 0.6 },
      { cue: 'license', prefer: ['licensed_as'], zoom: ['facts', 'episodes'], weight: 0.7 },
      { cue: 'compliant', prefer: ['complies_with'], zoom: ['facts'], weight: 0.6 },
      { cue: 'capital', prefer: ['capital_requirement'], zoom: ['facts'], weight: 0.6 },
      { cue: 'settlement', prefer: ['settlement_period'], zoom: ['facts'], weight: 0.6 },
      {
        cue: 'revoked',
        prefer: ['licensed_as', 'regulated_by'],
        zoom: ['episodes', 'facts'],
        weight: 0.7,
      },
      { cue: 'audit', prefer: ['complies_with'], zoom: ['audit_review', 'episodes'], weight: 0.6 },
    ],
    // License status and settlement conventions go stale (EMI licenses get
    // revoked; markets migrate T+2 to T+1) — serve them recency-checked.
    verificationRules: [
      { claimPattern: 'licensed', requires: 'recency_check' },
      { claimPattern: 'settlement', requires: 'recency_check' },
    ],
    retentionHints: [
      { predicateOrScene: 'regulated_by', hint: 'durable' },
      { predicateOrScene: 'licensed_as', hint: 'durable' },
      { predicateOrScene: 'complies_with', hint: 'durable' },
      { predicateOrScene: 'capital_requirement', hint: 'durable' },
      { predicateOrScene: 'settlement_period', hint: 'standard' },
      { predicateOrScene: 'audit_review', hint: 'durable' },
      { predicateOrScene: 'regulatory_filing', hint: 'standard' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // Financial evidence is DOCUMENTARY: statements, regulatory filings,
    // licence certificates, KYC paperwork. Document text extraction
    // (document → text) is the only core capability requested, and it is
    // the only one an installed adapter can run. `image` is deliberately
    // NOT declared: KYC identity photography is biometric-adjacent, and a
    // pack should not widen a tenant's media consent for evidence this
    // ontology (institutions and products, not people) never reasons over.
    modalities: ['text', 'document'],
    processors: [{ id: 'document_text', modality: 'document', produces: ['text'] }],
    // rawEvidence is DELIBERATELY ABSENT (omission = deny). Statements and
    // KYC files are the most re-identifiable artifacts in the library;
    // derived text is enough to answer a compliance question, so
    // gateRawEvidence refuses raw bytes and signed URLs for this pack.
  },
  evalFixtures: [
    {
      id: 'regulator',
      description: 'the regulating authority is extracted',
      text: 'Acme Pay is regulated by the FCA.',
      expect: { facts: [{ predicate: 'regulated_by', objectIncludes: 'FCA' }] },
    },
    {
      id: 'compliance',
      description: 'a named compliance standard is captured',
      text: 'The gateway is PCI-DSS compliant.',
      expect: { facts: [{ predicate: 'complies_with', objectIncludes: 'PCI-DSS' }] },
    },
    {
      id: 'settlement',
      description: 'the settlement window is captured verbatim',
      text: 'Equity trades settle T+2.',
      expect: { facts: [{ predicate: 'settlement_period', objectIncludes: 'T+2' }] },
    },
    {
      id: 'license',
      description: 'the license type is captured verbatim',
      text: 'Acme Pay is licensed as an EMI.',
      expect: { facts: [{ predicate: 'licensed_as', objectIncludes: 'EMI' }] },
    },
    {
      id: 'capital',
      description: 'a capital requirement is captured with its currency',
      text: 'The fund must hold €5M in own funds.',
      expect: { facts: [{ predicate: 'capital_requirement', objectIncludes: '€5M' }] },
    },
    {
      id: 'license-and-regulator',
      description: 'a compound registration sentence yields both facts',
      text: 'Nova Securities is a registered broker-dealer under SEC oversight.',
      expect: {
        facts: [
          { predicate: 'licensed_as', objectIncludes: 'broker-dealer' },
          { predicate: 'regulated_by', objectIncludes: 'SEC' },
        ],
      },
    },
  ],
};
