import { composePredicateId, type DomainPackManifest } from './manifest';

/**
 * The first real Domain Pack: code-memory (docs/roadmap/code-memory-domain.md).
 * The non-derivable engineering "why" of a codebase — decisions, rationale,
 * invariants, gotchas — anchored to code anchors. Previously these predicates
 * were hardcoded in CORE_PREDICATES (Phase 0 PoC shortcut); they now live here
 * as a versioned, namespaced pack, proving the pack standard end-to-end.
 *
 * As of 0.5.0 the memoryModel carries a MEDIA CONTRACT: failure/dashboard
 * screenshots and text-ish artifacts (logs, traces) as input modalities,
 * the core capabilities the Evidence Plane can actually run, and NO
 * raw-evidence declaration. 0.6.0 adds `ocr` now that a local OCR
 * processor exists — a screenshot of a red CI pane is this domain's most
 * common attachment and its text is the whole point of it. NOTE the
 * builtin caveat: builtins never pass through DomainPackInstallService, so
 * no `domain_pack` consent row exists for this pack — MemoryModelReader-
 * Service surfaces the declaration through its builtin union, but both
 * media gates still deny at their consent clause until a consent path for
 * builtins lands. The declaration is the contract, not an activation.
 *
 * 0.6.0 carries a SECOND, independent change that landed in the same
 * release window as the `ocr` declaration above — one bump, not two
 * stacked, so a consumer moves from 0.5.0 to 0.6.0 once.
 *
 * It corrects a DOMAIN MODELLING ERROR: `invariant` shipped as
 * `single_active` from the very first version, which silently made every
 * newly recorded constraint retire the previous one. A module's
 * invariants coexist, so that was data loss with nothing gained — there
 * is no "which invariant is current?" question for supersession to
 * answer. It is now `append_only`. A MINOR bump, not a patch: this
 * changes stored-fact behaviour for anyone already recording into the
 * pack (new invariants stop closing prior ones; previously superseded
 * rows stay superseded and remain readable at their `asOf`).
 * `decided`/`owns`/`default_value`/`depends_on_version` are deliberately
 * left `single_active` — each of those really does have exactly one
 * current value.
 *
 * 0.7.0 declares the DERIVABLE CLASS. Code is the domain where the split
 * is starkest: git is an external system of record that is better than
 * our copy — exact, versioned, cheap, and never wrong about the past. So
 * `owns` / `default_value` / `depends_on_version` are POINTERS at a
 * state of the repository, only as good as the commit they were read at,
 * while `decided` / `because` / `invariant` / `gotcha` /
 * `superseded_by` are MATERIALIZED prose that exists nowhere else and
 * does not rot when new commits land. The new
 * `source_version_match` verificationRule names the first group; the
 * second is simply not listed, and is therefore never swept.
 *
 * Bump `version` to ship an updated code-memory ontology.
 */
export const CODE_MEMORY_PACK: DomainPackManifest = {
  id: 'code_memory',
  version: '0.7.0',
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
VALUE  one invariant per fact (multi-valued — a module's constraints
       COEXIST: "every handler validates its body with the shared zod
       schema" and "amounts are always emitted in cents" are both true
       of the same file at the same time, and neither retires the other)`,
      datatype: 'string',
      // 0.6.0 semantics correction (was single_active through 0.5.0).
      // There is no "the current invariant" of a module the way there is
      // a current owner or a current default — a rule does not replace
      // the rule before it. Under single_active each newly recorded
      // constraint SUPERSEDED the last, so a file with five real rules
      // ended up remembering one; the reference repository indexer's
      // first dogfood pass over this repo had to drop 1254 legitimate
      // invariants across 515 anchors to avoid destroying its own
      // output. A retiring rule is a code CHANGE, and the fact then
      // stops being re-asserted; that is what append_only + decay is
      // for. Contrast `decided`, which stays single_active on purpose:
      // an anchor has exactly one CURRENT decision (k09), and
      // `superseded_by` records what replaced the old one.
      semantics: 'append_only',
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
NOT FOR prose fragments: the value must be value-shaped — a number,
       boolean, or enum token of a NAMED flag/config. A sentence
       fragment describing behaviour ("every duration in milliseconds")
       is never a default; a unit/behaviour rule belongs in invariant
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
it. A module's FILE PATH and the SYMBOL it defines are ONE entity, not two:
"src/gateway/webhook-dispatcher.ts" and "WebhookDispatcher" name the same
module — use the file path as the canonical subject for BOTH phrasings and
never mint a separate entity for the symbol spelling.
Prefer the code_memory__* predicates for the engineering "why":
decisions (code_memory__decided), their rationale (code_memory__because),
constraints (code_memory__invariant), pitfalls (code_memory__gotcha),
module/service ownership (code_memory__owns), the current default of a
flag/config (code_memory__default_value), pinned dependency versions
(code_memory__depends_on_version), and decision supersession
(code_memory__superseded_by). Copy identifiers, paths, versions, and values
VERBATIM — "3.2.4" not "the current version", "EXTRACTOR_LITERAL_HARVEST"
not "the harvest flag". Ownership INVERTS the surface grammar: in
"NAME owns PATH", the owned module/path is the fact's SUBJECT (a code
anchor) and the person or team is the VALUE of code_memory__owns.
code_memory__default_value takes ONLY value-shaped defaults of a NAMED
flag/config — a number, boolean, or enum token ("0", "true", "strict");
NEVER a prose fragment: a sentence fragment describing behaviour ("every
duration in milliseconds") must never become a default_value. A compound
invariant — one sentence stating a rule and its negation ("X, never Y")
— is ONE code_memory__invariant fact carrying BOTH clauses verbatim;
never split its clauses across facts or predicates.`,
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
      // 0.4.1: dedicated ownership example (k13 battery finding) — the
      // person-first phrasing with a repo qualifier and an "including …"
      // enumeration tail, which the compound example above did not cover.
      {
        text: 'Dmitri owns src/billing in ledger-core, including the invoice worker and the dunning cron.',
        note: "ownership inverts the sentence: the owned module 'src/billing' is the SUBJECT (a code anchor), the person is the value → code_memory__owns='Dmitri'. The 'including …' tail stays inside that one fact — no extra owns fact per sub-component.",
      },
      // 0.4.2: path↔symbol identity (k10 battery finding) — the symbol
      // phrasing must land on the path-canonical module entity, not on a
      // per-phrasing twin.
      {
        text: 'RateLimiter rejects a burst with 429 before the handler runs; it lives in src/gateway/rate-limiter.ts.',
        note: "the symbol 'RateLimiter' and the path 'src/gateway/rate-limiter.ts' are ONE entity — subject is the canonical path 'src/gateway/rate-limiter.ts' (the symbol is the same module, not a second entity) → code_memory__invariant='rejects a burst with 429 before the handler runs'.",
      },
      // 0.4.3: compound-invariant slotting (k10 battery finding, run
      // cmmtq1z412) — a two-clause "X, never Y" invariant was split and
      // its value-shaped-looking fragment mis-slotted as a config
      // default. The rule and its negation are ONE invariant fact.
      {
        text: 'PaymentNormalizer in ledger-core stores every duration in milliseconds, never seconds.',
        note: "a compound invariant stays ONE fact, verbatim with BOTH clauses — subject 'PaymentNormalizer' → code_memory__invariant='stores every duration in milliseconds, never seconds'. Do NOT split the clauses into separate facts, and do NOT slot the fragment 'every duration in milliseconds' as code_memory__default_value — a default is the value token ('0', 'true', 'strict') of a named flag/config, never a prose fragment.",
      },
    ],
  },
  // The domain perception contract (docs/domain-packs.md). Declarative data
  // only; consumable once the memory-model reader unions builtin manifests.
  // The media section (modalities/processors/rawEvidence) is the consent
  // surface everywhere else in the library; for a BUILTIN there is no
  // install to consent at, so it is a declaration only (see the header).
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
    verificationRules: [
      { claimPattern: 'default', requires: 'recency_check' },
      // THE DERIVABLE CLASS. Each of these three POINTS AT a state of the
      // working tree that git can re-derive exactly at any moment: who
      // owns a path (CODEOWNERS / authorship concentration), what a flag
      // or constant defaults to, which version a dependency is pinned to.
      // Stored as timeless truth they would start lying on the next
      // merge, so they are bound to the commit they were read at and go
      // back for re-verification when the source moves on.
      //
      // `decided`, `because`, `invariant`, `gotcha` and `superseded_by`
      // are deliberately ABSENT. They are interpretation — the reason a
      // choice was made, the constraint someone learned the hard way —
      // which exists only in prose and is lost without us. A statement
      // about the past does not become false because the future arrived,
      // so calendar age and commit drift are both the wrong question for
      // them.
      {
        requires: 'source_version_match',
        appliesTo: ['owns', 'default_value', 'depends_on_version'],
      },
    ],
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
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // Modest and honest. Engineering evidence that is not prose is a
    // SCREENSHOT of a failing run or a dashboard, and text-ish ARTIFACTS
    // (logs, stack traces, diffs) that arrive as document assets. Only the
    // two capabilities the trusted core can actually run today are
    // requested: image metadata (image → caption, which for a screenshot
    // is dimensions and media type, nothing more) and document text
    // extraction (document → text). No OCR of screenshots, no vision
    // captioner, no ASR — no adapter exists, so declaring one would arm a
    // capability that always denies.
    modalities: ['text', 'image', 'document'],
    processors: [
      { id: 'image_metadata', modality: 'image', produces: ['caption'] },
      { id: 'document_text', modality: 'document', produces: ['text'] },
      // 0.6.0: the screenshot is this domain's native artefact. A red CI
      // pane, a stack trace pasted as a picture, a dashboard at the
      // moment it went wrong — engineers attach these constantly, and the
      // one thing that makes them worth attaching is the TEXT in them:
      // the failing assertion, the error code, the metric name. Without
      // OCR the pack stores a picture of the answer to "why did this
      // break", which is exactly the non-derivable "why" it exists for.
      { id: 'image_ocr', modality: 'image', produces: ['ocr'] },
    ],
    // rawEvidence is DELIBERATELY ABSENT (omission = deny). A builtin is
    // seeded into EVERY tenant without an install decision, so it is the
    // last pack that should hold a raw-serving capability; derived
    // representations answer the engineering question either way.
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

/**
 * Namespaced id of the flag/config default slot
 * (`code_memory__default_value`), exported for the literal-harvest
 * flag-default rule. The deterministic producer MUST emit the SAME
 * predicate id the extraction profile teaches the LLM: two different
 * ids for one slot would defeat the (entity, predicate, object) dedup
 * between the lanes and split the single_active revision history
 * across two predicates. Guarded by a unit test against manifest
 * drift (the localId leaving the pack).
 */
export const CODE_MEMORY_DEFAULT_VALUE_PREDICATE = composePredicateId(
  CODE_MEMORY_PACK.id,
  'default_value',
);

/** Strip the pack prefix from a namespaced id → the local kind (for display). */
export function codeMemoryKindOf(predicateId: string): string {
  const prefix = `${CODE_MEMORY_PACK.id}__`;
  return predicateId.startsWith(prefix) ? predicateId.slice(prefix.length) : predicateId;
}
