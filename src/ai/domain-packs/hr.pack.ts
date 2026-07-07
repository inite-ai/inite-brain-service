import type { DomainPackManifest } from './manifest';

/**
 * Industry Domain Pack: HR / recruiting. DISTRIBUTABLE (installed per-tenant from
 * `packs/hr.pack.json`, NOT in BUILTIN_PACKS). Captures role/candidate ontology —
 * required skills, seniority, compensation, employment type, location policy.
 * Scoped to ROLES/REQUISITIONS, not individual PII. Bump `version` to update.
 */
export const HR_PACK: DomainPackManifest = {
  id: 'hr',
  version: '0.1.0',
  description:
    'HR / recruiting ontology — required skills, seniority, compensation, employment type, and work location of roles, with a domain extraction profile.',
  predicates: [
    {
      localId: 'requires_skill',
      displayLabel: 'requires skill',
      description: `TYPE   subject is a role/requisition; value is a required skill
ADMIT  text states a skill/qualification the role requires ("requires
       Kubernetes", "must know Python")
VALUE  one skill per fact, verbatim ("Kubernetes")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'seniority',
      displayLabel: 'seniority',
      description: `TYPE   subject is a role; value is a seniority level
ADMIT  text states the seniority ("Senior", "Staff", "5+ years
       experience")
VALUE  the seniority term, verbatim ("Senior")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'compensation',
      displayLabel: 'compensation',
      description: `TYPE   subject is a role; value is a compensation range/amount
ADMIT  text states pay/salary/comp ("$150k–$180k", "£90,000 base")
VALUE  the compensation, verbatim ("$150k–$180k")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'employment_type',
      displayLabel: 'employment type',
      description: `TYPE   subject is a role; value is an employment type
ADMIT  text states the type ("full-time", "contract", "part-time")
VALUE  the type, verbatim ("full-time")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'work_location',
      displayLabel: 'work location',
      description: `TYPE   subject is a role; value is a work-location policy
ADMIT  text states remote/hybrid/onsite or a location ("remote",
       "hybrid, 2 days in Berlin")
VALUE  the location policy, verbatim ("remote")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `HR / recruiting inputs describe ROLES or job requisitions (not
individuals — do not extract personal candidate data). Treat the named role as
the SUBJECT entity. Prefer the hr__* predicates for required skills
(hr__requires_skill), seniority (hr__seniority), compensation
(hr__compensation), employment type (hr__employment_type), and work location
(hr__work_location). Copy skills, levels, pay, and location policies VERBATIM —
"Kubernetes" not "container tech", "$150k–$180k" not "competitive".`,
    fewShot: [
      {
        text: 'Senior Backend Engineer, full-time, remote — requires Go and Kubernetes; $160k–$190k.',
        note: "role 'Senior Backend Engineer' → hr__seniority='Senior', hr__employment_type='full-time', hr__work_location='remote', hr__requires_skill='Go', hr__requires_skill='Kubernetes', hr__compensation='$160k–$190k'.",
      },
      {
        text: 'Contract role, hybrid 2 days in Berlin, must know Python.',
        note: "→ hr__employment_type='Contract', hr__work_location='hybrid 2 days in Berlin', hr__requires_skill='Python'.",
      },
    ],
  },
  evalFixtures: [
    {
      id: 'skill',
      description: 'a required skill is extracted',
      text: 'This role requires Kubernetes.',
      expect: { facts: [{ predicate: 'requires_skill', objectIncludes: 'Kubernetes' }] },
    },
    {
      id: 'comp',
      description: 'the compensation range is captured',
      text: 'Compensation is $150k–$180k.',
      expect: { facts: [{ predicate: 'compensation', objectIncludes: '$150k' }] },
    },
    {
      id: 'location',
      description: 'the work-location policy is captured',
      text: 'This position is fully remote.',
      expect: { facts: [{ predicate: 'work_location', objectIncludes: 'remote' }] },
    },
  ],
};
