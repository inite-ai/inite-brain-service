import { envFlagEnabled } from './env-validation';

/**
 * Evidence substrate (Brain v2.1 M1) master flag —
 * EVIDENCE_SUBSTRATE_ENABLED.
 *
 * When on, EvidenceStoreService accepts writes to the three 0109 tables
 * (evidence_asset / evidence_fragment / derived_representation). The env
 * read lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable (no
 * restart). Default off ⇒ every writer refuses and NO row is ever written
 * — byte-identical prod (shadow substrate: nothing on the serving path
 * reads these tables even when on). The GDPR cascade and the retention
 * sweep run REGARDLESS of this flag — rows written while it was on must
 * stay erasable after it is turned off. EVIDENCE_ family sits off the
 * ENGINE flag budget by design (a substrate builder, not an engine fork).
 *
 * Reserved for sibling PRs (NOT defined yet — do not read them):
 * EVIDENCE_INGEST_ENABLED (PR-C ingest surface), EVIDENCE_SCENE_LINKS
 * (scene↔asset membership), EVIDENCE_FRAGMENT_CITATIONS (answer-path
 * fragment citations).
 */
export function evidenceSubstrateEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_SUBSTRATE_ENABLED);
}

/**
 * Filesystem storage-adapter root — EVIDENCE_FS_ROOT (non-boolean).
 *
 * The directory the fs:// adapter stores content-addressed blobs under
 * (<root>/<companyId>/<hash[0..1]>/<hash>). NO default, deliberately: a
 * default path would silently accumulate tenant media in an unmanaged
 * location — unset ⇒ adapter methods throw a clear unconfigured error
 * instead. Resolved here in the common layer (engine-gates S5.2); read
 * at call time so a change is runtime-mutable.
 */
export function evidenceFsRoot(): string | null {
  const raw = process.env.EVIDENCE_FS_ROOT;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

/** Default declared-byteLength sanity cap: 1 GiB. (Named WITHOUT the
 *  full env-key substring so the W6 boot-capture truth gate doesn't
 *  mistake this module-scope default for a boot-captured read.) */
const DEFAULT_MAX_BYTES = 1073741824;

/**
 * Declared-size sanity cap — EVIDENCE_MAX_BYTES (non-boolean).
 *
 * registerAsset rejects a declared byteLength above this cap — a bound on
 * what a caller may claim an observation weighs, NOT a transfer limit
 * (this PR ships no upload endpoint). A non-boolean knob resolved here in
 * the common layer so the write seam takes a resolved number (engine-
 * gates S5.2); read at call time so a change is runtime-mutable. Must be
 * a positive integer; unset, blank, or invalid → the 1 GiB default.
 */
export function evidenceMaxBytes(): number {
  const raw = process.env.EVIDENCE_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BYTES;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}

/**
 * Trusted processor broker (Brain v2.1 MM-1, migration 0121) —
 * EVIDENCE_PROCESSOR_BROKER.
 *
 * When on, EvidenceProcessorBrokerService dispatches platform-owned
 * processor adapters over registered evidence assets and records each
 * execution as an idempotent processing_run row. Default off ⇒ dispatch
 * throws 503 BEFORE any query is issued and NO row is ever written —
 * byte-identical prod. The env read lives here in the common layer, NOT
 * inside the engine dirs (engine-gates S5.2); read at call time so a
 * flip is runtime-mutable. Requires EVIDENCE_SUBSTRATE_ENABLED to do
 * anything useful (validateEvidenceProcessingEnv warns on the
 * inconsistent pair). EVIDENCE_ family sits off the ENGINE flag budget
 * by design (a substrate builder, not an engine fork).
 */
export function processorBrokerEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_PROCESSOR_BROKER);
}

/**
 * External-ingest quarantine seam (Brain v2.1 MM-6, migration 0121) —
 * EVIDENCE_QUARANTINE.
 *
 * When on, registerAsset stamps evidence_asset.quarantineStatus ('clean'
 * for internal writes, 'quarantined' for origin:'external_ingest') and
 * EvidenceQuarantineService may run scan transitions. Default off ⇒ the
 * field is NEVER written (byte-identical rows), quarantine transitions
 * throw 503, and origin:'external_ingest' is REJECTED 503 — fail closed:
 * no external bytes may enter without the seam. Read at call time
 * (runtime-mutable); common layer per engine-gates S5.2.
 */
export function evidenceQuarantineEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_QUARANTINE);
}

/** Default derived-output cap: 1 MiB. (Named WITHOUT the full env-key
 *  substring so the W6 boot-capture truth gate doesn't mistake this
 *  module-scope default for a boot-captured read.) */
const DEFAULT_DERIVED_CAP = 1048576;

/**
 * Derived-output size cap — EVIDENCE_DERIVED_MAX_BYTES (non-boolean).
 *
 * Bounds BOTH what a processor adapter may read from a blob and the
 * byte length of any single derived-representation content it returns —
 * an over-cap output FAILS the run (reject, never truncate: silent
 * truncation would alter derived content). Resolved here in the common
 * layer (engine-gates S5.2); read at call time so a change is
 * runtime-mutable. Must be a positive integer; unset, blank, or invalid
 * → the 1 MiB default.
 */
export function evidenceDerivedMaxBytes(): number {
  const raw = process.env.EVIDENCE_DERIVED_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DERIVED_CAP;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_DERIVED_CAP;
}

/**
 * Claim-state write side (Drift-1, migration 0115) —
 * EVIDENCE_GROUNDING_STAMP.
 *
 * When on, the fact resolver's post-resolve tail stamps
 * `knowledge_fact.groundingStatus` ('grounded' | 'ungrounded', computed
 * by common/grounding-status.ts from the presence of observational
 * source) onto every created/updated winner row — both ingest paths
 * (typed fact REST/MCP and mention-persist) and the derive batch, the
 * stampFactScope idiom: best-effort, warn-never-fail, kept OUT of
 * fn::resolve_fact. Absent field = legacy row (pre-flag), never
 * backfilled. Off (default) ⇒ no extra UPDATE is ever issued —
 * byte-identical rows. Read at call time (runtime-mutable).
 *
 * Reserved for a FUTURE sibling (NOT defined — do not read it):
 * EVIDENCE_REQUIRE_OBSERVATION_STRICT — a reject-mode on top of the same
 * groundingStatusOf helper; this PR deliberately marks, never rejects.
 */
export function groundingStampEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_GROUNDING_STAMP);
}

/**
 * Fail-closed mention capture — EVIDENCE_FAIL_CLOSED_CAPTURE.
 *
 * When on, ingestMention REQUIRES the L0 episode write
 * (EPISODE_SUBSTRATE_ENABLED) to succeed: captureTurn must return an
 * episode id, else the mention is rejected 503 (retryable infra state,
 * not caller error) — no extraction without a stored observation. On
 * success the captured id is stamped into every extracted fact's
 * source.episodeIds. Requires the substrate flag (env-validation warns
 * on the inconsistent pair — with capture disabled every mention would
 * be rejected). Off (default) ⇒ capture stays the non-fatal advisory it
 * is today — byte-identical. Read at call time (runtime-mutable).
 */
export function failClosedCaptureEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_FAIL_CLOSED_CAPTURE);
}

/**
 * Consolidation gate — EVIDENCE_UNGROUNDED_EXCLUDE.
 *
 * When on, the promotion runner excludes members whose stored
 * groundingStatus = 'ungrounded' from summary groups BEFORE the
 * group-size floor — an unfounded claim must not consolidate into
 * long-term memory, nor count toward a group qualifying. Legacy rows
 * (absent field) still promote (no backfill ⇒ fail-open for legacy by
 * design). Off (default) ⇒ member selection AND the member SELECT string
 * are byte-identical. Read at call time (runtime-mutable).
 */
export function ungroundedExcludeEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_UNGROUNDED_EXCLUDE);
}

/**
 * Strict serving — EVIDENCE_UNGROUNDED_SERVING_GATE.
 *
 * When on, a supported verdict batch-checks its cited facts' stored
 * groundingStatus; when EVERY citation is 'ungrounded' the answer
 * abstains under reason 'ungrounded_evidence' (the fifth sequential
 * downgrade on the supported serve — the evidence_capability_unmet
 * idiom). Mixed or legacy support serves; resolution failure fails OPEN
 * with a warn (a DB hiccup must not abstain a grounded answer). Off
 * (default) ⇒ no fetch, byte-identical serve. Read at call time
 * (runtime-mutable).
 */
export function ungroundedServingGateEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_UNGROUNDED_SERVING_GATE);
}
