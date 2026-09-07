/**
 * The coding-agent corpus and check battery: ~20 turns of realistic
 * coding-agent narration about a FICTIONAL repo, "acme-api" — a
 * decision superseded, a flag introduced dark then enabled, a
 * dependency pinned then bumped, ownership, a gotcha bound to a
 * version, a PR merged then reverted, and voiced plans that must NOT
 * become transitions. One module ("webhook-dispatcher") is referenced
 * BOTH by file path and by symbol name, so entity identity is
 * measured, not assumed. That module's name is RUN-SCOPED
 * (moduleIdentity): entities are tenant-global, so a static name would
 * make every rerun re-measure the twins the FIRST run minted instead
 * of its own resolution — buildTurns/buildChecks take the run id.
 *
 * Current predicate ids are DERIVED from the real builtin manifest
 * (src/ai/domain-packs/code-memory.pack.ts) through a guard that
 * throws when a referenced localId leaves the pack. Ids arriving with
 * the pack 0.4.0 ontology increment (owns / default_value /
 * depends_on_version / superseded_by) are composed through a helper
 * that READS the live manifest: while they are absent the check
 * carries a gap annotation (`expectedUnknown`) saying it cannot pass
 * yet; the moment 0.4.0 lands, the annotation softens to
 * "never measured" automatically — the battery never hardcodes green.
 *
 * Scoreability rules inherited from the siblings:
 *  - transition turns never restate the OLD value, so history
 *    subsequences and serve markers cannot cross-match;
 *  - every provenance fragment appears VERBATIM in exactly one turn,
 *    under the 600-char provenance text cap;
 *  - serve markers are value-shaped and never occur in decline
 *    phrasings; numeric markers (9187, 120) are unique to one turn.
 */
import { CODE_MEMORY_PACK } from '../../../src/ai/domain-packs/code-memory.pack';
import { composePredicateId } from '../../../src/ai/domain-packs/manifest';
import { STATE_CHANGE_PREDICATE } from '../../../src/ai/extractor-internals/state-verb-harvest';
import { symbolAliasForPath } from '../../../src/ingest/code-alias';
import type { Check, CorpusTurn } from './types';

export { CODE_MEMORY_PACK };

/** The vertical every corpus mention attributes itself to. */
export const CORPUS_VERTICAL = 'work';

/**
 * Namespaced id of a predicate the pack declares TODAY, guarded
 * against manifest drift: a localId that leaves the pack makes the
 * corpus refuse to build (the domain-pack battery's packPredicate).
 */
export function currentPredicate(localId: string): string {
  if (!CODE_MEMORY_PACK.predicates.some((p) => p.localId === localId)) {
    throw new Error(
      `corpus references code_memory__${localId}, which is not in ` +
        `code_memory@${CODE_MEMORY_PACK.version}`,
    );
  }
  return composePredicateId(CODE_MEMORY_PACK.id, localId);
}

/** Is `localId` declared by the live builtin manifest? */
export function packHasPredicate(localId: string): boolean {
  return CODE_MEMORY_PACK.predicates.some((p) => p.localId === localId);
}

/**
 * Namespaced id of a predicate EXPECTED from the pack 0.4.0 ontology
 * increment. Unlike currentPredicate this never throws: the id is
 * composed either way, and `gap040` (below) supplies the honest
 * annotation for the period the predicate does not exist.
 */
export function plannedPredicate(localId: string): string {
  return composePredicateId(CODE_MEMORY_PACK.id, localId);
}

/**
 * Gap annotation for a check that targets a 0.4.0 predicate. While
 * the manifest does not declare it, the check CANNOT pass and says
 * so; once 0.4.0 lands the annotation self-softens to the
 * never-measured baseline (extraction consulting the pack vocabulary
 * still has zero observations) — computed from the LIVE manifest, so
 * no edit here is needed when the parallel PR merges.
 */
export function gap040(localId: string, alsoUnknown: string): string {
  if (packHasPredicate(localId)) {
    return `Outcome never measured: ${alsoUnknown}`;
  }
  return (
    `code_memory@${CODE_MEMORY_PACK.version} does not declare "${localId}" — ` +
    `it arrives with the pack 0.4.0 ontology increment, so this check cannot ` +
    `pass today and its fail is the recorded gap. Also unmeasured: ${alsoUnknown}`
  );
}

/** Baseline annotation for the 4 predicates that DO exist today. */
export const PROFILE_GAP =
  'code_memory ships no extractionProfile (the only pack without one — audit ' +
  'gap #2), so mention-path phrasing has never canonicalized into ' +
  'code_memory__* vocabulary; a coined open-vocab predicate here is the ' +
  'baseline finding. Flips green when the extraction-profile PR (pack 0.3.0) ' +
  'lands and extraction consults it.';

/** Gap annotation for the flag-transition history check. */
export const FLAG_TRANSITION_GAP =
  'Diagnosed 2026-09 (k08 lottery): the state-verb lane binds "we enabled ' +
  'FLAG" to a person-or-speaker holder — absent on agent-recorded turns, so ' +
  'the match DROPS — and the LLM redraw sometimes lands a stage as a decided ' +
  'paraphrase carrying the prose markers and sometimes as the typed ' +
  'code_memory__default_value only. The stages therefore accept BOTH surface ' +
  'forms; the deterministic producer of the typed form is the literal-harvest ' +
  'flag-default rule, so EXTRACTOR_LITERAL_HARVEST must be ON at the stand ' +
  'for the check to hold every run. A fail with the lane off is the recorded ' +
  'gap; a fail with it on is a regression.';

/** Real (today) namespaced ids — drift-guarded. */
export const CM = {
  decided: currentPredicate('decided'),
  because: currentPredicate('because'),
  invariant: currentPredicate('invariant'),
  gotcha: currentPredicate('gotcha'),
} as const;

/** Planned (pack 0.4.0) namespaced ids — composed, never guarded. */
export const CM_040 = {
  owns: plannedPredicate('owns'),
  defaultValue: plannedPredicate('default_value'),
  dependsOnVersion: plannedPredicate('depends_on_version'),
  supersededBy: plannedPredicate('superseded_by'),
} as const;

// ── run-scoped module identity (k10 hermeticity) ────────────────────

/**
 * The dual-phrasing module (path + symbol), RUN-SCOPED.
 *
 * Why: knowledge entities are tenant-GLOBAL while corpus facts are
 * per-run user-scoped. With a static module name, run N's path/symbol
 * turns resolve onto whatever entities run 1 minted — so a twin pair
 * created before INGEST_CODE_ALIAS_RESOLUTION existed poisons every
 * later run's k10 measurement (measured live: runs cm-dogfood-1..3 on
 * pre-#453 code minted the `src/gateway/webhook-dispatcher.ts` /
 * `WebhookDispatcher` twins; run cm-dogfood-4, flags ON, reused BOTH via
 * the step-2 exact-name match and re-measured the stale split). The
 * battery already namespaces conversations per run; the module identity
 * follows the same principle, so each run measures ITS OWN resolution.
 *
 * The symbol is derived through the REAL product helper
 * (symbolAliasForPath), so the corpus can never drift from the
 * convention the resolver implements — a slug the helper cannot derive
 * makes the corpus refuse to build.
 */
export interface ModuleIdentity {
  /** File-path phrasing, e.g. "src/gateway/webhook-dispatcher-r7kq.ts". */
  path: string;
  /** Symbol phrasing, e.g. "WebhookDispatcherR7kq". */
  symbol: string;
  /** Kebab basename without extension. */
  basename: string;
  /** canonicalName needles for the k10 check (lowercased match). */
  nameTokens: string[];
}

/**
 * Sanitize a run id into a slug usable as a kebab-case basename part
 * AND a PascalCase hump: lowercase alphanumerics, letter-first
 * (digit-leading ids get an `r` prefix). Empty in → empty out.
 */
export function moduleRunSlug(runId: string): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug === '') return '';
  return /^[a-z]/.test(slug) ? slug : `r${slug}`;
}

export function moduleIdentity(runId = ''): ModuleIdentity {
  const slug = moduleRunSlug(runId);
  const basename = slug === '' ? 'webhook-dispatcher' : `webhook-dispatcher-${slug}`;
  const path = `src/gateway/${basename}.ts`;
  const symbol = symbolAliasForPath(path);
  if (symbol === null) {
    throw new Error(`corpus module path "${path}" derives no symbol — bad run slug "${slug}"`);
  }
  return {
    path,
    symbol,
    basename,
    // Run-scoped tokens name THIS run's module only. The unscoped
    // fallback keeps the historical natural-language token so the
    // static exports stay byte-identical.
    nameTokens:
      slug === ''
        ? [basename, symbol.toLowerCase(), 'webhook dispatcher']
        : [basename, symbol.toLowerCase()],
  };
}

/** Timestamp of turn N (1-based) — 5 minutes apart within a session. */
const t = (startIso: string, turn: number): string =>
  new Date(Date.parse(startIso) + (turn - 1) * 5 * 60_000).toISOString();

const conv = (conversation: string, startIso: string, texts: string[]): CorpusTurn[] =>
  texts.map((text, i) => ({ conversation, turn: i + 1, emittedAt: t(startIso, i + 1), text }));

// ── the four conversations ──────────────────────────────────────────

/** Decision conversation — decision + rationale + invariant + gotcha,
 *  then a superseding decision on the same subject. The dual-phrasing
 *  module appears here by PATH (run-scoped — see moduleIdentity). */
const decisionTurns = (m: ModuleIdentity): CorpusTurn[] =>
  conv('decision', '2026-09-01T09:00:00Z', [
    'We decided to route every outbound webhook in acme-api through ' +
      `${m.path} — one dispatch path instead of six ad-hoc fetch calls.`,
    'The reason: retry and signing logic had drifted between the six webhook call-sites, ' +
      'and two of them never signed payloads at all.',
    'Invariant for acme-api: every route handler must validate its body with the shared ' +
      'zod schema from src/gateway/schemas.ts, or the contract tests fail.',
    'Gotcha in acme-api: pnpm run migrate --dry-run still acquires the schema lock, ' +
      'so a dry run can deadlock a live deploy.',
    'Update: we walked the single-dispatcher decision back — outbound webhooks in acme-api ' +
      'now go through the managed queue relay in src/gateway/queue-relay.ts.',
  ]);

/** Flags conversation — a flag introduced dark (default 0), the
 *  literal lane's identifier / port / rate-limit prose, the SYMBOL
 *  phrasing of the shared module (run-scoped), then the flag
 *  enablement (0→1). */
const flagsTurns = (m: ModuleIdentity): CorpusTurn[] =>
  conv('flags', '2026-09-01T15:00:00Z', [
    'We introduced the ACME_RETRY_QUEUE flag in acme-api; it ships disabled and its ' +
      'default stays 0 until the queue is proven.',
    'The gateway metrics endpoint in acme-api listens on port 9187.',
    'acme-api throttles /v1/webhooks at 120 requests per minute.',
    `${m.symbol} in acme-api emits every line-item amount in cents, never floats.`,
    'We enabled ACME_RETRY_QUEUE in prod today; its default is now 1 for every acme-api tenant.',
  ]);

/** Deps conversation — a pin, the bump (1.2.0 → 2.0.0), ownership,
 *  a gotcha bound to the new version, and a second pinned dep. */
const DEPS_TURNS = conv('deps', '2026-09-02T10:00:00Z', [
  'acme-api pins redis-client at 1.2.0; the pin lives in the root package.json.',
  'We bumped redis-client to 2.0.0 in acme-api — the new cluster API is required by ' +
    'the retry queue.',
  'Priya owns src/gateway in acme-api, including the webhook dispatcher and the queue relay.',
  'Gotcha with redis-client 2.0.0 in acme-api: SCAN cursors are strings now, and comparing ' +
    'them to zero makes the loop silently never terminate.',
  'The staging database for acme-api is SurrealDB 3.2.4, pinned in docker-compose.staging.yml.',
]);

/** Mixed conversation — a merge then its revert, TWO voiced-plan
 *  turns that must NOT flip state, and a postmortem line. */
const MIXED_TURNS = conv('mixed', '2026-09-03T11:00:00Z', [
  'We merged PR #212 in acme-api — it lands the queue-relay cutover for outbound webhooks.',
  'We reverted PR #212 this morning; the cutover doubled webhook latency for the EU tenants.',
  'We should probably enable ACME_STRICT_MODE for acme-api next quarter; nobody has ' +
    'measured the blast radius yet.',
  'For the record, we have not enabled ACME_STRICT_MODE anywhere in acme-api.',
  'Postmortem for Friday: the acme-api worker pool ran out of file descriptors because ' +
    'orphan webhook sockets piled up unclosed.',
]);

/**
 * The corpus turns, run-scoped: the dual-phrasing module carries the
 * run's slug so k10 measures THIS run's entity resolution instead of
 * re-measuring whatever twins an earlier (possibly pre-flag) run left
 * in the tenant-global entity space. No runId → the historical static
 * texts, byte-identical (unit-test surface).
 */
export function buildTurns(runId = ''): CorpusTurn[] {
  const m = moduleIdentity(runId);
  return [...decisionTurns(m), ...flagsTurns(m), ...DEPS_TURNS, ...MIXED_TURNS];
}

/** Back-compat static corpus (unscoped module names). */
export const ALL_TURNS: CorpusTurn[] = buildTurns();

// ── the checks ──────────────────────────────────────────────────────

/** The check battery, run-scoped in lockstep with buildTurns. */
export function buildChecks(runId = ''): Check[] {
  const m = moduleIdentity(runId);
  return [
    // ── setup: the builtin seeding path itself ────────────────────────
    {
      kind: 'builtin-vocab',
      id: 'k01-builtin-seeded',
      cls: 'setup',
      intent:
        'The builtin code_memory predicates are active in the tenant WITHOUT any ' +
        'install (bootstrap seeding; the install path rejects the builtin id by design).',
      requiredPredicates: [CM.decided, CM.because, CM.invariant, CM.gotcha],
    },

    // ── pack-vocab, today's ontology (honest baseline: no profile) ────
    {
      kind: 'pack-vocab',
      id: 'k02-vocab-decided',
      cls: 'vocab',
      intent: `The dispatch decision canonicalizes into ${CM.decided}, not a coined predicate.`,
      searchQuery: 'acme-api outbound webhook dispatch decision',
      predicate: CM.decided,
      valueMarkers: ['dispatch'],
      expectedUnknown: PROFILE_GAP,
    },
    {
      kind: 'pack-vocab',
      id: 'k03-vocab-invariant',
      cls: 'vocab',
      intent: `The zod-schema rule lands on ${CM.invariant} with the verbatim constraint.`,
      searchQuery: 'acme-api route handler body validation invariant',
      predicate: CM.invariant,
      valueMarkers: ['zod'],
      expectedUnknown: PROFILE_GAP,
    },
    {
      kind: 'pack-vocab',
      id: 'k04-vocab-gotcha',
      cls: 'vocab',
      intent: `The dry-run deadlock trap lands on ${CM.gotcha}.`,
      searchQuery: 'acme-api migrate dry run schema lock',
      predicate: CM.gotcha,
      valueMarkers: ['schema lock'],
      expectedUnknown: PROFILE_GAP,
    },

    // ── pack-vocab, the 0.4.0 ontology increment (gap-gated) ──────────
    {
      kind: 'pack-vocab',
      id: 'k05-vocab-default-value',
      cls: 'vocab',
      intent: `The flag default lands on ${CM_040.defaultValue} as a typed single_active value.`,
      searchQuery: 'ACME_RETRY_QUEUE default value',
      predicate: CM_040.defaultValue,
      valueMarkers: ['0', '1'],
      expectedUnknown: gap040(
        'default_value',
        'whether extraction routes flag-default phrasing into the typed predicate.',
      ),
    },
    {
      kind: 'pack-vocab',
      id: 'k06-vocab-depends-on-version',
      cls: 'vocab',
      intent: `The redis-client bump lands on ${CM_040.dependsOnVersion} with the new version.`,
      searchQuery: 'acme-api redis-client version',
      predicate: CM_040.dependsOnVersion,
      valueMarkers: ['2.0.0'],
      expectedUnknown: gap040(
        'depends_on_version',
        'whether extraction routes dependency-version phrasing into the typed predicate.',
      ),
    },

    // ── literal lane fit inside coding prose ──────────────────────────
    {
      kind: 'literal-harvest',
      id: 'k07-literal-harvest',
      cls: 'harvest',
      intent:
        'The deterministic literal lane (EXTRACTOR_LITERAL_HARVEST, ON at the stand) ' +
        'produces its core facts from identifier-heavy coding prose: the ALL_CAPS flag, ' +
        'the metrics port and the route rate limit each land as a typed literal fact.',
      wants: [
        {
          searchQuery: 'ACME_RETRY_QUEUE flag',
          predicate: 'identifier',
          valueMarkers: ['ACME_RETRY_QUEUE'],
        },
        {
          searchQuery: 'acme-api gateway metrics port',
          predicate: 'service_port',
          valueMarkers: ['9187'],
        },
        {
          searchQuery: 'acme-api webhooks rate limit',
          predicate: 'rate_limit',
          valueMarkers: ['120'],
        },
      ],
    },

    // ── the flag 0→1 transition as ordered history ────────────────────
    {
      kind: 'flag-transition',
      id: 'k08-flag-transition',
      cls: 'transition',
      intent:
        'ONE entity timeline retains the flag story in order: introduced dark ' +
        '(ships disabled, default 0) then enabled (default 1). Each stage ' +
        'accepts the verbatim prose form (an LLM decided/state paraphrase) OR ' +
        'the typed form — the predicate+object surface of the single_active ' +
        'code_memory__default_value slot the pack doctrine routes flag ' +
        "defaults into (matched against the timeline event's " +
        '"predicate object" string, so "default_value 0" hits the typed ' +
        'fact and never a corpus turn).',
      searchQuery: 'ACME_RETRY_QUEUE flag default',
      stages: [
        ['ships disabled', 'default stays 0', 'default_value 0'],
        ['enabled ACME_RETRY_QUEUE', 'default is now 1', 'default_value 1'],
      ],
      expectedUnknown: FLAG_TRANSITION_GAP,
    },

    // ── supersession, mechanically (MCP write path) ───────────────────
    {
      kind: 'supersession-asof',
      id: 'k09-supersession-asof',
      cls: 'mcp',
      intent:
        'Re-recording a `decided` on one anchor SUPERSEDES: `why` now serves exactly ' +
        'ONE active decision (the new one), and `why` at an asOf between the writes ' +
        'still recalls the old one — and not yet the new one (bitemporal).',
      anchor: 'acme-api/src/gateway/queue-relay.ts',
      oldText: 'Route webhook retries through the in-process queue.',
      newText: 'Route webhook retries through the managed queue relay.',
      oldMarkers: ['in-process'],
      newMarkers: ['managed queue relay'],
    },

    // ── entity identity across phrasings ──────────────────────────────
    {
      kind: 'cross-entity',
      id: 'k10-cross-entity',
      cls: 'identity',
      intent:
        `The module referenced by PATH (${m.path}) and by ` +
        `SYMBOL (${m.symbol}) resolves to ONE entity carrying facts seeded by ` +
        'both phrasings — no per-phrasing duplication. Identity ONLY: the marker ' +
        'scan is predicate-agnostic over ALL facts of the resolved entity, so a ' +
        'clause extraction split or mis-slotted still counts when it is attached ' +
        'to the one module (slot quality is k02–k06 scope).',
      searchQuery: 'acme-api webhook dispatcher',
      nameTokens: m.nameTokens,
      mustCarryGroups: [
        ['dispatch path', 'outbound webhook'],
        ['cents', 'line-item'],
      ],
    },

    // ── provenance ────────────────────────────────────────────────────
    {
      kind: 'trace-provenance',
      id: 'k11-trace-provenance',
      cls: 'trace',
      intent: "A dispatch-decision fact unrolls to the seeded decision turn's episode verbatim.",
      searchQuery: 'acme-api outbound webhook dispatch decision',
      objectHint: ['dispatch', 'webhook'],
      episodeFragments: ['one dispatch path instead of six'],
    },

    // ── serving ───────────────────────────────────────────────────────
    {
      kind: 'serve',
      id: 'k12-serve-current-default',
      cls: 'serving',
      intent:
        'The dogfood north-star question — "what is the current default of X" — serves ' +
        'the NEW value and never the stale one.',
      query: 'What is the current default of ACME_RETRY_QUEUE in acme-api?',
      expectAnyOf: ['now 1', 'is 1', 'to 1', 'default of 1', 'enabled'],
      forbidAnyOf: ['default is 0', 'defaults to 0', 'stays 0', 'still 0', 'disabled'],
      expectedUnknown: gap040(
        'default_value',
        'whether "current default" serves correctly without a typed single_active home.',
      ),
    },
    {
      kind: 'serve',
      id: 'k13-serve-owner',
      cls: 'serving',
      intent: 'Module-ownership serving: "who owns src/gateway" names the owner.',
      query: 'Who owns src/gateway in acme-api?',
      expectAnyOf: ['Priya'],
      forbidAnyOf: [],
      expectedUnknown: gap040(
        'owns',
        'whether ownership phrasing survives open-vocab extraction well enough to serve.',
      ),
    },

    // ── the intention guard must hold ─────────────────────────────────
    {
      kind: 'intention-guard',
      id: 'k14-intention-guard',
      cls: 'guard',
      intent:
        'The voiced-plan turns ("should probably enable", "have not enabled") must NOT ' +
        'produce a completed state transition for ACME_STRICT_MODE — this must stay ' +
        'green BOTH before and after the coding-verb lexicon lands (the 6-token guards ' +
        'are what keep it green after).',
      searchQuery: 'ACME_STRICT_MODE',
      forbidPredicate: STATE_CHANGE_PREDICATE,
      forbidObjectMarkers: ['ACME_STRICT_MODE'],
    },

    // ── MCP round-trip ────────────────────────────────────────────────
    {
      kind: 'mcp-roundtrip',
      id: 'k15-mcp-roundtrip',
      cls: 'mcp',
      intent: 'record_decision → why on a fresh anchor round-trips (found>0, right kind, text).',
      anchor: 'acme-api/src/ingest/replay-window.ts',
      recordKind: 'decided',
      text: 'Cap the replay window at 48 hours; longer windows re-deliver acknowledged webhooks.',
      textMarkers: ['48 hours', 'replay window'],
    },

    // ── surfaces ──────────────────────────────────────────────────────
    {
      kind: 'no-rogue-tools',
      id: 'k16-no-rogue-tools',
      cls: 'surfaces',
      intent:
        'The code-memory tools (why / recall_decisions / record_decision) are core ' +
        'single-underscore names and no pack declares mcpTools, so tools/list must ' +
        'carry ZERO __-namespaced pack tools — asserted, not assumed.',
    },
  ];
}

/** Back-compat static battery (unscoped module names). */
export const CHECKS: Check[] = buildChecks();
