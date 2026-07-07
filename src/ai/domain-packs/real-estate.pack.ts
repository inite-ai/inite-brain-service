import type { DomainPackManifest } from './manifest';

/**
 * The second real Domain Pack: real-estate. UNLIKE code-memory (a builtin,
 * globally seeded), real-estate is a DISTRIBUTABLE pack — it is NOT in
 * BUILTIN_PACKS; it is installed per-tenant at runtime from its JSON manifest
 * (`packs/real-estate.pack.json`, kept in sync with this module by
 * `test/real-estate-pack.unit-spec.ts`) via `pnpm pack:install`.
 *
 * It is also the first pack to ship an `extractionProfile`: domain guidance +
 * few-shot that the extractor injects into its system prompt for tenants who
 * install it (src/ai/predicate-registry.service loadFresh →
 * ExtractorLlmService.composeSystemPrompt). This proves the DomainPack machine
 * end-to-end: a community pack contributes both ontology AND extraction tuning
 * without a core change or redeploy.
 *
 * Bump `version` to ship an updated real-estate ontology / profile.
 */
export const REAL_ESTATE_PACK: DomainPackManifest = {
  id: 'real_estate',
  version: '0.1.0',
  description:
    'Real-estate ontology — zoning, valuation, encumbrances, tenure, and construction of properties/parcels, with a domain extraction profile.',
  predicates: [
    {
      localId: 'zoned_as',
      displayLabel: 'zoned as',
      description: `TYPE   subject is a property/parcel; value is its zoning class
ADMIT  text states a property's zoning designation ("zoned R-2",
       "commercial zoning", "mixed-use")
VALUE  the zoning code/class, verbatim ("R-2", "commercial")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'valued_at',
      displayLabel: 'valued at',
      description: `TYPE   subject is a property/parcel; value is an appraised/market value
ADMIT  text states a valuation or appraised worth of the property
       ("appraised at $840,000", "market value €1.2M")
VALUE  the amount, verbatim including currency ("$840,000")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'listed_at',
      displayLabel: 'listed at',
      description: `TYPE   subject is a property/parcel; value is its current asking price
ADMIT  text states the listing / asking / sale price ("listed at
       $1.5M", "asking 350k")
VALUE  the asking amount, verbatim ("$1.5M")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'encumbered_by',
      displayLabel: 'encumbered by',
      description: `TYPE   subject is a property/parcel; value is an encumbrance on it
ADMIT  text states a lien, mortgage, easement, or covenant burdening
       the property ("mortgage held by First National", "utility
       easement", "tax lien")
VALUE  one encumbrance per fact, verbatim ("mortgage", "easement")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'tenure_type',
      displayLabel: 'tenure type',
      description: `TYPE   subject is a property/parcel; value is the ownership tenure
ADMIT  text states the tenure/estate type ("freehold", "leasehold",
       "commonhold")
VALUE  the tenure term, verbatim ("leasehold")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'built_in',
      displayLabel: 'built in',
      description: `TYPE   subject is a property/parcel; value is its construction year
ADMIT  text states when the structure was built/constructed ("built
       in 1998", "constructed 2010")
VALUE  the year, verbatim ("1998")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Real-estate inputs describe properties or parcels. Treat a street
address ("12 Elm St"), unit ("Unit 4B"), or lot/parcel id as the SUBJECT entity
(type location). Prefer the real_estate__* predicates for zoning
(real_estate__zoned_as), valuation (real_estate__valued_at), asking price
(real_estate__listed_at), liens/mortgages/easements (real_estate__encumbered_by),
tenure (real_estate__tenure_type), and construction year (real_estate__built_in).
Copy amounts, zoning codes, tenure terms, and years VERBATIM from the text —
"$840,000" not "840000", "R-2" not "residential". When a named party holds an
encumbrance, ALSO emit an edge to that party (e.g. Property —held_by→ Bank).`,
    fewShot: [
      {
        text: 'The parcel at 12 Elm St is zoned R-2 and was last appraised at $840,000.',
        note: "property '12 Elm St' (location) → real_estate__zoned_as='R-2', real_estate__valued_at='$840,000'.",
      },
      {
        text: 'Unit 4B is leasehold and carries a mortgage held by First National.',
        note: "property 'Unit 4B' → real_estate__tenure_type='leasehold', real_estate__encumbered_by='mortgage'; edge (Unit 4B, held_by, First National).",
      },
      {
        text: 'The warehouse, built in 1998, is listed at $1.5M with a utility easement.',
        note: "property 'The warehouse' → real_estate__built_in='1998', real_estate__listed_at='$1.5M', real_estate__encumbered_by='easement'.",
      },
    ],
  },
};
