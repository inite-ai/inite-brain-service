import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: insurance. DISTRIBUTABLE (installed per-tenant from
 * `packs/insurance.pack.json`, NOT in BUILTIN_PACKS). Captures policy ontology —
 * coverage, limits, premiums, deductibles, exclusions — with an extractionProfile
 * + eval fixtures. Bump `version` to ship an update.
 */
export const INSURANCE_PACK: DomainPackManifest = {
  id: 'insurance',
  version: '0.1.0',
  description:
    'Insurance ontology — coverage, limits, premiums, deductibles, and exclusions of policies, with a domain extraction profile.',
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
  ],
};
