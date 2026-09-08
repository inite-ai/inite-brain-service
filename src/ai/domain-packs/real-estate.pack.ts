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
 * As of 0.2.0 it also ships a `memoryModel` (listing / tenancy / permit
 * lifecycles, attention + retention hints, recency rules for asking-price and
 * appraisal claims) — the domain perception contract consumed by
 * MemoryModelReaderService for installed tenants.
 *
 * As of 0.3.0 the memoryModel also carries a MEDIA CONTRACT: listing
 * photography and floor-plan documents as input modalities, the core
 * capabilities the Evidence Plane can actually run, and
 * `rawEvidence: { serve: true }` — listing media is published marketing
 * material whose whole purpose is to be looked at. 0.4.0 adds `ocr` now
 * that a local OCR processor exists: a floor plan's entire content is
 * lettering, and a caption of one says nothing a buyer asked.
 *
 * Bump `version` to ship an updated real-estate ontology / profile.
 */
export const REAL_ESTATE_PACK: DomainPackManifest = {
  id: 'real_estate',
  version: '0.4.0',
  description:
    'Real-estate ontology — zoning, valuation, encumbrances, tenure, and construction of properties/parcels, with a domain extraction profile and memory model.',
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
  // The domain perception contract (docs/domain-packs.md). Declarative data
  // only — consumed by MemoryModelReaderService for installed tenants.
  // The media section (modalities/processors/rawEvidence) is the consent
  // surface: installing this pack requires `acceptModalities: true`.
  memoryModel: {
    sceneSchemas: [
      {
        id: 'viewing',
        description:
          'A property viewing or open house: prospective buyers or tenants inspect the property and reactions are recorded.',
        cues: ['viewing', 'open house', 'walkthrough', 'showed the property'],
      },
      {
        id: 'closing',
        description:
          'A transaction closing: contracts are exchanged, funds settle, and title transfers on a property deal.',
        cues: ['closing', 'completion', 'exchanged contracts', 'title transfer', 'escrow'],
      },
    ],
    stateModels: [
      {
        id: 'listing_lifecycle',
        subjectType: 'listing',
        states: ['listed', 'under_offer', 'sold', 'withdrawn'],
        transitions: [
          { from: 'listed', to: 'under_offer' },
          { from: 'under_offer', to: 'listed' },
          { from: 'under_offer', to: 'sold' },
          { from: 'listed', to: 'withdrawn' },
          { from: 'withdrawn', to: 'listed' },
        ],
      },
      {
        id: 'tenancy_lifecycle',
        subjectType: 'tenancy',
        states: ['advertised', 'let', 'notice_given', 'vacated'],
        transitions: [
          { from: 'advertised', to: 'let' },
          { from: 'let', to: 'notice_given' },
          { from: 'notice_given', to: 'vacated' },
          { from: 'vacated', to: 'advertised' },
        ],
      },
      {
        id: 'permit_lifecycle',
        subjectType: 'planning_permit',
        states: ['applied', 'granted', 'refused', 'expired'],
        transitions: [
          { from: 'applied', to: 'granted' },
          { from: 'applied', to: 'refused' },
          { from: 'granted', to: 'expired' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'zoned', prefer: ['zoned_as'], zoom: ['facts'], weight: 0.6 },
      { cue: 'appraised', prefer: ['valued_at'], zoom: ['facts'], weight: 0.6 },
      { cue: 'asking price', prefer: ['listed_at', 'valued_at'], zoom: ['facts'], weight: 0.6 },
      { cue: 'lien', prefer: ['encumbered_by'], zoom: ['facts', 'episodes'], weight: 0.7 },
      { cue: 'easement', prefer: ['encumbered_by'], zoom: ['facts'], weight: 0.6 },
      { cue: 'leasehold', prefer: ['tenure_type'], zoom: ['facts'], weight: 0.5 },
      { cue: 'under offer', prefer: ['listed_at'], zoom: ['episodes', 'facts'], weight: 0.6 },
      { cue: 'built in', prefer: ['built_in'], zoom: ['facts'], weight: 0.4 },
    ],
    // Asking prices move and appraisals expire — serve both recency-checked.
    verificationRules: [
      { claimPattern: 'listed at', requires: 'recency_check' },
      { claimPattern: 'appraised', requires: 'recency_check' },
    ],
    retentionHints: [
      { predicateOrScene: 'tenure_type', hint: 'durable' },
      { predicateOrScene: 'built_in', hint: 'durable' },
      { predicateOrScene: 'encumbered_by', hint: 'durable' },
      { predicateOrScene: 'zoned_as', hint: 'durable' },
      { predicateOrScene: 'valued_at', hint: 'standard' },
      { predicateOrScene: 'listed_at', hint: 'standard' },
      { predicateOrScene: 'closing', hint: 'durable' },
      { predicateOrScene: 'viewing', hint: 'ephemeral' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // Property evidence is photographic (listing photos, viewing snaps)
    // and documentary (floor plans, EPCs, permit paperwork). Only the two
    // capabilities the trusted core can actually run today are requested:
    // image metadata (image → caption) and document text extraction
    // (document → text). OCR / ASR / vision-caption are deliberately NOT
    // declared — no adapter is installed for them.
    modalities: ['text', 'image', 'document'],
    processors: [
      { id: 'image_metadata', modality: 'image', produces: ['caption'] },
      { id: 'document_text', modality: 'document', produces: ['text'] },
      // 0.4.0: a floor plan is a picture whose entire information content
      // is lettering — room labels, dimension strings, a scale bar, a
      // unit number. So is a site-plan crop, a zoning map extract, or the
      // price panel of a listing sheet exported as JPEG. The pack's own
      // predicates (zoning class, valuation, tenure) read off exactly
      // those strings, and nothing but OCR puts them in reach.
      { id: 'image_ocr', modality: 'image', produces: ['ocr'] },
    ],
    // The one first-party pack that declares raw serving: a listing photo
    // or floor plan is published marketing material, and an agent asking
    // "show me the kitchen" needs the artifact itself, not a caption of
    // it. Declaring it only OPENS the gate — gateRawEvidence still
    // requires current modality consent AND passes every fragment through
    // the media-PII gate (unclassified fails closed; classified needs
    // brain:read_media).
    rawEvidence: { serve: true },
  },
  evalFixtures: [
    {
      id: 'zoning',
      description: 'zoning code is extracted from a parcel mention',
      text: 'The parcel at 12 Elm St is zoned R-2.',
      expect: { facts: [{ predicate: 'zoned_as', objectIncludes: 'R-2' }] },
    },
    {
      id: 'valuation',
      description: 'appraised value is captured verbatim with currency',
      text: 'The property at 8 Oak Ave was appraised at $840,000.',
      expect: { facts: [{ predicate: 'valued_at', objectIncludes: '$840,000' }] },
    },
    {
      id: 'tenure',
      description: 'ownership tenure is captured',
      text: 'Unit 4B is held on a leasehold basis.',
      expect: { facts: [{ predicate: 'tenure_type', objectIncludes: 'leasehold' }] },
    },
    {
      id: 'listing-price',
      description: 'the asking price is captured verbatim',
      text: 'The warehouse is listed at $1.5M.',
      expect: { facts: [{ predicate: 'listed_at', objectIncludes: '$1.5M' }] },
    },
    {
      id: 'encumbrance',
      description: 'an encumbrance on the property is captured',
      text: 'The property at 12 Elm St carries a mortgage held by First National.',
      expect: { facts: [{ predicate: 'encumbered_by', objectIncludes: 'mortgage' }] },
    },
    {
      id: 'construction-year',
      description: 'the construction year is captured verbatim',
      text: 'The house at 8 Oak Ave was built in 1998.',
      expect: { facts: [{ predicate: 'built_in', objectIncludes: '1998' }] },
    },
  ],
};
