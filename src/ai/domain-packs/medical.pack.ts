import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: medical / clinical pharmacology. A DISTRIBUTABLE pack
 * (installed per-tenant from `packs/medical.pack.json`, NOT in BUILTIN_PACKS).
 * Scoped to DRUG / TREATMENT ontology (indications, dosing, interactions,
 * contraindications) — not patient records — so its predicates are piiClass
 * 'none'. Ships an extractionProfile + eval fixtures. Bump `version` to update.
 */
export const MEDICAL_PACK: DomainPackManifest = {
  id: 'medical',
  version: '0.1.0',
  description:
    'Clinical pharmacology ontology — indications, dosing, routes, interactions, and contraindications of drugs/treatments, with a domain extraction profile.',
  predicates: [
    {
      localId: 'treats',
      displayLabel: 'treats',
      description: `TYPE   subject is a drug/treatment; value is a condition it is indicated for
ADMIT  text states what the drug is indicated for / treats ("indicated
       for hypertension", "treats type 2 diabetes")
VALUE  one condition per fact, verbatim ("hypertension")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'dosed_at',
      displayLabel: 'dosed at',
      description: `TYPE   subject is a drug; value is a dosage
ADMIT  text states the dose/strength/frequency ("500 mg twice daily",
       "10 mg once daily")
VALUE  the dosage, verbatim ("500 mg twice daily")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'administered_via',
      displayLabel: 'administered via',
      description: `TYPE   subject is a drug; value is a route of administration
ADMIT  text states how the drug is given ("oral", "intravenous",
       "subcutaneous injection")
VALUE  the route, verbatim ("oral", "IV")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'interacts_with',
      displayLabel: 'interacts with',
      description: `TYPE   subject is a drug; value is another drug/substance it interacts with
ADMIT  text states a drug-drug/drug-food interaction ("interacts with
       warfarin", "avoid with grapefruit")
VALUE  one interacting agent per fact, verbatim ("warfarin")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'contraindicated_with',
      displayLabel: 'contraindicated with',
      description: `TYPE   subject is a drug; value is a condition/population it must not be used in
ADMIT  text states a contraindication ("contraindicated in pregnancy",
       "not for patients with renal impairment")
VALUE  one contraindication per fact, verbatim ("pregnancy")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Clinical inputs describe DRUGS or TREATMENTS (not patients). Treat
the named drug/treatment as the SUBJECT entity. Prefer the medical__* predicates
for indications (medical__treats), dosing (medical__dosed_at), route
(medical__administered_via), interactions (medical__interacts_with), and
contraindications (medical__contraindicated_with). Copy conditions, doses,
routes, and interacting agents VERBATIM — "500 mg twice daily" not "twice a
day", "warfarin" not "blood thinner". Do NOT infer patient-specific facts; this
pack captures drug ontology, not clinical records.`,
    fewShot: [
      {
        text: 'Metformin is indicated for type 2 diabetes, dosed at 500 mg twice daily, taken orally.',
        note: "drug 'Metformin' → medical__treats='type 2 diabetes', medical__dosed_at='500 mg twice daily', medical__administered_via='orally'.",
      },
      {
        text: 'Warfarin interacts with aspirin and is contraindicated in pregnancy.',
        note: "drug 'Warfarin' → medical__interacts_with='aspirin', medical__contraindicated_with='pregnancy'.",
      },
      {
        text: 'Ceftriaxone is administered via intravenous infusion.',
        note: "drug 'Ceftriaxone' → medical__administered_via='intravenous infusion'.",
      },
    ],
  },
  evalFixtures: [
    {
      id: 'indication',
      description: 'the treated condition is extracted',
      text: 'Metformin is indicated for type 2 diabetes.',
      expect: { facts: [{ predicate: 'treats', objectIncludes: 'type 2 diabetes' }] },
    },
    {
      id: 'dose',
      description: 'the dosage is captured verbatim',
      text: 'Amoxicillin is dosed at 500 mg three times daily.',
      expect: { facts: [{ predicate: 'dosed_at', objectIncludes: '500 mg' }] },
    },
    {
      id: 'contraindication',
      description: 'a contraindication is captured',
      text: 'Isotretinoin is contraindicated in pregnancy.',
      expect: {
        facts: [{ predicate: 'contraindicated_with', objectIncludes: 'pregnancy' }],
      },
    },
  ],
};
