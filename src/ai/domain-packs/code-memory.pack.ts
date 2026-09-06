import { composePredicateId, type DomainPackManifest } from './manifest';

/**
 * The first real Domain Pack: code-memory (docs/roadmap/code-memory-domain.md).
 * The non-derivable engineering "why" of a codebase — decisions, rationale,
 * invariants, gotchas — anchored to code anchors. Previously these predicates
 * were hardcoded in CORE_PREDICATES (Phase 0 PoC shortcut); they now live here
 * as a versioned, namespaced pack, proving the pack standard end-to-end.
 *
 * Bump `version` to ship an updated code-memory ontology.
 */
export const CODE_MEMORY_PACK: DomainPackManifest = {
  id: 'code_memory',
  version: '0.4.0',
  description:
    'Non-derivable engineering "why" of a codebase — decisions, rationale, invariants, gotchas, ownership, flag/config defaults, dependency pins, and decision supersession anchored to code, with a domain extraction profile and memory model.',
  // Retro-declaration, documentation-true: code-memory has ALWAYS been an
  // external indexer — its capture pipeline runs where the code lives
  // (raw source never leaves the machine) and posts typed facts. No
  // in-process extraction run exists for it.
  indexer: { mode: 'external' },
  predicates: [
    {
      localId: 'decided',
      displayLabel: 'decided',
      description: `TYPE   subject is a code anchor; value is a design decision
ADMIT  text states a design/implementation decision made for this code
       location ("resolve facts through one gateway", "split per phase")
VALUE  the decision statement`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'because',
      displayLabel: 'because',
      description: `TYPE   subject is a code anchor; value is the rationale for a decision
ADMIT  text gives the reason a decision was made ("21 positional args
       drifted between call-sites")
VALUE  one rationale per fact (multi-valued)`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'invariant',
      displayLabel: 'invariant',
      description: `TYPE   subject is a code anchor; value is a constraint that must hold
ADMIT  text states a rule the code must satisfy ("always export a new
       @Injectable from the @Global module or e2e DI-boot fails")
VALUE  the invariant statement`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'gotcha',
      displayLabel: 'gotcha',
      description: `TYPE   subject is a code anchor; value is a non-obvious trap
ADMIT  text warns of a counter-intuitive behaviour or pitfall
       ("pnpm test -- --testPathPattern does NOT work — double dash")
VALUE  one gotcha per fact (multi-valued)`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    // ── 0.4.0 ontology increment (dogfood gaps: ownership, flag/config
    //    defaults, dependency pins, decision supersession) ─────────────
    {
      localId: 'owns',
      displayLabel: 'owned by',
      description: `TYPE   subject is a code anchor (module/service/area); value is the owner
ADMIT  text assigns ownership or responsibility for the subject to a
       person or team ("mikefluff owns src/fovea", "the platform team
       owns the ingest service")
VALUE  the owning person/team, verbatim ("mikefluff", "platform team")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'default_value',
      displayLabel: 'default value',
      description: `TYPE   subject is a flag/config identifier entity; value is its current default
ADMIT  text states the current default of a feature flag, env var, or
       config setting ("EXTRACTOR_LITERAL_HARVEST defaults to 0",
       "the timeout default is 10000"). Revisioned: a new default
       supersedes the old one; history is retained
NOT FOR the value a caller passes at one call-site — only the DEFAULT
VALUE  the default value, verbatim ("0", "1", "10000")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'depends_on_version',
      displayLabel: 'depends on version',
      description: `TYPE   subject is a dependency (library/service/tool) entity; value is
       the version currently pinned or in use
ADMIT  text states the version a dependency is pinned at or running
       ("prod SurrealDB is 3.2.4", "bumped jest to 30"). Revisioned:
       a bump supersedes the old pin; history is retained
VALUE  the version, verbatim ("3.2.4", "30")`,
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'superseded_by',
      displayLabel: 'superseded by',
      description: `TYPE   subject is a code anchor whose earlier decision was replaced;
       value names what replaced it
ADMIT  text states that a decision/approach for this code location was
       superseded, replaced, or abandoned in favour of another ("the
       opt-out was replaced by the always-on integrity gate")
VALUE  the superseding decision statement, one per fact (multi-valued —
       the supersession trail is history, never silently overwritten)`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  // CAUTION: code_memory is a BUILTIN — this profile is injected into EVERY
  // tenant's extraction prompt (predicate-registry loadFresh assembles builtin
  // profiles unconditionally). It is therefore SELF-SCOPING: the first lines
  // fence it to software-work inputs and tell the extractor to contribute
  // nothing anywhere else.
  extractionProfile: {
    guidance: `Apply this profile ONLY when the input discusses software work —
code, repositories, modules, services, feature flags, env vars, deploys,
dependencies, or engineering decisions. For any other domain this profile
contributes NOTHING. When it applies: identifier-shaped subjects become their
OWN entities — an ALL_CAPS flag or env var ("EXTRACTOR_LITERAL_HARVEST"), a
file or module path ("src/ingest/fact-resolver.service.ts"), a dotted symbol
or package name is the SUBJECT of its facts, NEVER the speaker who mentions
it. Prefer the code_memory__* predicates for the engineering "why":
decisions (code_memory__decided), their rationale (code_memory__because),
constraints (code_memory__invariant), pitfalls (code_memory__gotcha),
module/service ownership (code_memory__owns), the current default of a
flag/config (code_memory__default_value), pinned dependency versions
(code_memory__depends_on_version), and decision supersession
(code_memory__superseded_by). Copy identifiers, paths, versions, and values
VERBATIM — "3.2.4" not "the current version", "EXTRACTOR_LITERAL_HARVEST"
not "the harvest flag".`,
    fewShot: [
      {
        text: 'We decided to resolve all facts through one gateway in src/ingest/fact-resolver.service.ts because 21 positional args drifted between call-sites.',
        note: "code anchor 'src/ingest/fact-resolver.service.ts' → code_memory__decided='resolve all facts through one gateway', code_memory__because='21 positional args drifted between call-sites'.",
      },
      {
        text: 'EXTRACTOR_LITERAL_HARVEST defaults to 0 in production.',
        note: "flag entity 'EXTRACTOR_LITERAL_HARVEST' (the identifier is the SUBJECT, not the speaker) → code_memory__default_value='0'.",
      },
      {
        text: 'Prod SurrealDB is pinned at 3.2.4, and mikefluff owns src/fovea.',
        note: "dependency 'SurrealDB' → code_memory__depends_on_version='3.2.4'; module 'src/fovea' → code_memory__owns='mikefluff'.",
      },
      {
        text: 'Our decision to cache answers per request in src/answers/cache.ts was superseded by caching per tenant.',
        note: "code anchor 'src/answers/cache.ts' → code_memory__superseded_by='caching per tenant' (the old decided fact stays in history).",
      },
    ],
  },
  // The domain perception contract (docs/domain-packs.md). Declarative data
  // only; consumable once the memory-model reader unions builtin manifests.
  // Text-only — no modalities/processors/rawEvidence, so no consent surface.
  memoryModel: {
    sceneSchemas: [
      {
        id: 'change_session',
        description:
          'A focused engineering change: a flag flip, dependency bump, merge, revert, deploy, or rollback discussed or performed.',
        cues: ['merged', 'reverted', 'deployed', 'rolled back', 'flipped', 'bumped'],
      },
    ],
    stateModels: [
      {
        id: 'flag_lifecycle',
        subjectType: 'feature_flag',
        states: ['declared', 'enabled', 'deprecated', 'removed'],
        transitions: [
          { from: 'declared', to: 'enabled' },
          { from: 'enabled', to: 'deprecated' },
          { from: 'enabled', to: 'removed' },
          { from: 'deprecated', to: 'removed' },
        ],
      },
      {
        id: 'dependency_lifecycle',
        subjectType: 'dependency',
        states: ['added', 'bumped', 'removed'],
        transitions: [
          { from: 'added', to: 'bumped' },
          { from: 'bumped', to: 'bumped' },
          { from: 'added', to: 'removed' },
          { from: 'bumped', to: 'removed' },
        ],
      },
      {
        id: 'change_lifecycle',
        subjectType: 'change',
        states: ['proposed', 'merged', 'reverted'],
        transitions: [
          { from: 'proposed', to: 'merged' },
          { from: 'merged', to: 'reverted' },
          { from: 'reverted', to: 'merged' },
        ],
      },
    ],
    attentionHints: [
      { cue: 'gotcha', prefer: ['gotcha'], zoom: ['facts', 'episodes'], weight: 0.7 },
      { cue: 'invariant', prefer: ['invariant'], zoom: ['facts'], weight: 0.7 },
      { cue: 'default', prefer: ['default_value'], zoom: ['facts'], weight: 0.6 },
      { cue: 'flag', prefer: ['default_value', 'gotcha'], zoom: ['facts'], weight: 0.5 },
      {
        cue: 'because',
        prefer: ['because', 'decided'],
        zoom: ['facts', 'episodes'],
        weight: 0.6,
      },
      { cue: 'who owns', prefer: ['owns'], zoom: ['facts'], weight: 0.6 },
      { cue: 'version', prefer: ['depends_on_version'], zoom: ['facts'], weight: 0.5 },
    ],
    // The dogfood north-star claim class: "what is the current default of X"
    // must not serve stale — a default_value claim deserves a recency check.
    verificationRules: [{ claimPattern: 'default', requires: 'recency_check' }],
    retentionHints: [
      { predicateOrScene: 'decided', hint: 'durable' },
      { predicateOrScene: 'invariant', hint: 'durable' },
      { predicateOrScene: 'gotcha', hint: 'durable' },
      { predicateOrScene: 'superseded_by', hint: 'durable' },
      { predicateOrScene: 'because', hint: 'standard' },
      { predicateOrScene: 'owns', hint: 'standard' },
      { predicateOrScene: 'default_value', hint: 'standard' },
      { predicateOrScene: 'depends_on_version', hint: 'standard' },
      { predicateOrScene: 'change_session', hint: 'standard' },
    ],
  },
  // Scored by POST /v1/admin/packs/code_memory/eval (resolves the builtin
  // manifest in-process) — one fixture per new predicate + the classic
  // decision/rationale and gotcha shapes.
  evalFixtures: [
    {
      id: 'decision_rationale',
      description: 'a decision and its rationale are extracted onto the code anchor',
      text: 'We decided to resolve all facts through one gateway in src/ingest/fact-resolver.service.ts because 21 positional args drifted between call-sites.',
      expect: {
        facts: [
          { predicate: 'decided', objectIncludes: 'gateway' },
          { predicate: 'because', objectIncludes: 'drifted' },
        ],
      },
    },
    {
      id: 'gotcha',
      description: 'a pitfall warning is captured',
      text: 'Gotcha: pnpm test -- --testPathPattern does not work in this repo; use --testPathPatterns.',
      expect: { facts: [{ predicate: 'gotcha', objectIncludes: 'testPathPattern' }] },
    },
    {
      id: 'flag_default',
      description: 'the current default of a feature flag is captured on the flag entity',
      text: 'The feature flag EXTRACTOR_LITERAL_HARVEST defaults to 0.',
      expect: { facts: [{ predicate: 'default_value', objectIncludes: '0' }] },
    },
    {
      id: 'dependency_version',
      description: 'a pinned dependency version is captured verbatim',
      text: 'Production SurrealDB is pinned at 3.2.4.',
      expect: { facts: [{ predicate: 'depends_on_version', objectIncludes: '3.2.4' }] },
    },
    {
      id: 'ownership',
      description: 'module ownership is captured',
      text: 'mikefluff owns the src/fovea module.',
      expect: { facts: [{ predicate: 'owns', objectIncludes: 'mikefluff' }] },
    },
    {
      id: 'supersession',
      description: 'a decision supersession link is captured',
      text: 'Our decision to cache answers per request in src/answers/cache.ts was superseded by caching per tenant.',
      expect: { facts: [{ predicate: 'superseded_by', objectIncludes: 'per tenant' }] },
    },
  ],
};

/** The pack-local kinds, in author order. The ergonomic surface for the MCP
 *  `record_decision` tool + the capture pipeline (callers pass `decided`, not
 *  the namespaced id). Deliberately the decision-journal SUBSET of the pack's
 *  predicates: the 0.4.0 additions (owns/default_value/depends_on_version/
 *  superseded_by) arrive via the extraction path, not `record_decision`. */
export const CODE_MEMORY_KINDS = ['decided', 'because', 'invariant', 'gotcha'] as const;
export type CodeMemoryKind = (typeof CODE_MEMORY_KINDS)[number];

/** Fully-qualified, namespaced predicate id for a code-memory kind, e.g.
 *  `code_memory__decided`. Single source of truth for every consumer. */
export function codeMemoryPredicateId(kind: CodeMemoryKind): string {
  return composePredicateId(CODE_MEMORY_PACK.id, kind);
}

/** The set of namespaced code-memory predicate ids (for filtering reads). */
export const CODE_MEMORY_PREDICATE_IDS: string[] = CODE_MEMORY_KINDS.map(codeMemoryPredicateId);

/** Strip the pack prefix from a namespaced id → the local kind (for display). */
export function codeMemoryKindOf(predicateId: string): string {
  const prefix = `${CODE_MEMORY_PACK.id}__`;
  return predicateId.startsWith(prefix) ? predicateId.slice(prefix.length) : predicateId;
}
