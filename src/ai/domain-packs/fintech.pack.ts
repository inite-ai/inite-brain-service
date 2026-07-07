import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: fintech / financial-services regulation. Like
 * real-estate (and unlike the builtin code-memory), a DISTRIBUTABLE pack —
 * installed per-tenant from `packs/fintech.pack.json` via `pnpm pack:install`,
 * NOT in BUILTIN_PACKS, so its domain predicates don't seed into unrelated
 * tenants. Ships an extractionProfile + eval fixtures so it's a complete,
 * self-verifying ontology, not a stub. Bump `version` to ship an update.
 */
export const FINTECH_PACK: DomainPackManifest = {
  id: 'fintech',
  version: '0.1.0',
  description:
    'Financial-services regulation ontology — regulators, licenses, compliance standards, capital, and settlement of institutions/products, with a domain extraction profile.',
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
  ],
};
