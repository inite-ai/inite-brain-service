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
 * Formerly reserved here, all landed: EVIDENCE_FRAGMENT_CITATIONS
 * (MM-zoom PR2) and EVIDENCE_INGEST_ENABLED (PR-C ingest surface) live
 * below; the scene↔asset membership seam landed as
 * SCENES_EVIDENCE_LINKS — the writer is a scene pass, so it keeps the
 * SCENES_ family naming (see scene-flags.ts).
 */
export function evidenceSubstrateEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_SUBSTRATE_ENABLED);
}

/**
 * Evidence ingest surface (Brain v2.1 M3) — EVIDENCE_INGEST_ENABLED.
 *
 * When on, POST /v1/ingest/evidence-asset exists; off (default) the
 * route answers a bare 404 (the scenes-surface precedent — a dark route
 * does not advertise itself) and prod stays byte-identical. The surface
 * is METADATA-ONLY (MM-6 boundary): originUri required, no bytes, no
 * storageRef — blob-backed registration stays service-level until the
 * upload/quarantine design lands. Both this flag AND
 * EVIDENCE_SUBSTRATE_ENABLED must be on for a call to succeed: ingest-on
 * with substrate-off answers 503 from the write seam and env-validation
 * warns at boot about the inconsistent pair. Read at call time
 * (runtime-mutable). Env read lives here in the common layer, NOT inside
 * the engine dirs (engine-gates S5.2).
 */
export function evidenceIngestEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_INGEST_ENABLED);
}

/**
 * Blob upload surface (Brain v2.1 MM-7) — EVIDENCE_BLOB_UPLOAD_ENABLED.
 *
 * When on, POST /v1/ingest/evidence-blob exists: the ONE surface that
 * takes BYTES into custody (multipart/form-data), stores them through the
 * content-addressed storage adapter, and registers the resulting asset
 * blob-backed (availability 'hot'). Off (default) ⇒ the route answers a
 * bare 404 BEFORE the multipart body is parsed (the interceptor gate — an
 * off surface must not buffer a caller's bytes) and prod stays
 * byte-identical.
 *
 * Sits ON TOP of the sibling flags rather than replacing them: the write
 * seam still needs EVIDENCE_SUBSTRATE_ENABLED (503 off), and — because
 * bytes arriving over HTTP ARE external ingest — the upload registers with
 * origin 'external_ingest', which the store REFUSES (503) unless
 * EVIDENCE_QUARANTINE is on. That is the MM-6 doctrine held verbatim, not
 * a new rule: no external bytes may enter without the scan seam.
 * EVIDENCE_INGEST_ENABLED governs only the metadata-only sibling route
 * and is deliberately NOT consulted here — a deployment may take bytes
 * without opening caller-asserted metadata registration, or the reverse.
 *
 * Read at call time (runtime-mutable). Env read lives here in the common
 * layer, NOT inside the controller (engine-gates S5.2).
 */
export function evidenceBlobUploadEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_BLOB_UPLOAD_ENABLED);
}

/**
 * Sharing surface (Brain v2.1 MM-4, migration 0122) —
 * EVIDENCE_GRANTS_API_ENABLED.
 *
 * When on, EvidenceGrantsController exposes the three ownership verbs
 * over an existing asset: POST /v1/evidence/{assetId}/grants (share),
 * GET /v1/evidence/{assetId}/grants (list live owners) and DELETE
 * /v1/evidence/grants/{grantId} (revoke). Off (default) ⇒ every route
 * answers a bare 404 — raised in a GUARD, so it precedes the global
 * ValidationPipe and a malformed body cannot turn the dark route into a
 * route-revealing 400 (the EVIDENCE_BLOB_UPLOAD_ENABLED interceptor
 * lesson, applied to a JSON body).
 *
 * The surface is the reason 0122's write seam was held back
 * service-only: a sharing route is exactly where a hash-probing client
 * would look for an existence oracle. It therefore addresses assets ONLY
 * by record id (never by byteHash), requires the caller to pass the same
 * ownership + media-PII fences the raw-read gateway applies before it
 * will act, and answers ONE bare 404 for every negative outcome —
 * unknown asset, foreign tenant, dead asset, non-owner and PII-blocked
 * are indistinguishable in status, body and DB round-trips.
 *
 * Needs EVIDENCE_SUBSTRATE_ENABLED to write (the store's own 503 gate;
 * the controller double-gates to a 404 so a dark substrate advertises no
 * sharing surface at all) — env-validation warns at boot on the
 * inconsistent pair. Read at call time (runtime-mutable); the env read
 * lives here in the common layer, NOT in the controller (engine-gates
 * S5.2). EVIDENCE_ family sits off the ENGINE flag budget by design.
 */
export function evidenceGrantsApiEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_GRANTS_API_ENABLED);
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
 * what a caller may claim an observation weighs. It is ALSO the transfer
 * bound of the blob upload surface (EVIDENCE_BLOB_UPLOAD_ENABLED), where
 * it is applied as `min(cap, the upload interceptor's memory-storage
 * ceiling)` — deny-overrides, so raising this knob past that ceiling
 * raises nothing. A non-boolean knob resolved here in the common layer so
 * the write seam takes a resolved number (engine-gates S5.2); read at
 * call time so a change is runtime-mutable. Must be a positive integer;
 * unset, blank, or invalid → the 1 GiB default.
 */
export function evidenceMaxBytes(): number {
  const raw = process.env.EVIDENCE_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BYTES;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}

/**
 * Orphan-blob GC (Brain v2.1 MM-7 follow-up) — EVIDENCE_ORPHAN_BLOB_GC.
 *
 * THE LEAK THIS CLOSES. The upload path stores bytes BEFORE the asset
 * row exists (put() → registerAsset), and deliberately does not delete
 * them when registration fails: put() is content-addressed, so those
 * bytes may already back another row, and an eager unlink would destroy
 * someone else's evidence. Correct, and it leaks — a failed
 * registration, a crashed request, a killed process leaves bytes on disk
 * that no row references. This flag turns on the sweep that finds them.
 *
 * STAGE ONE IS REPORT-ONLY. This flag alone makes the sweep EXIST and
 * REPORT: it enumerates, joins against the live rows, and logs/metrics
 * what it WOULD reclaim, deleting nothing. Unlinking needs the second
 * stage (EVIDENCE_ORPHAN_BLOB_GC_DELETE below) — an operator looks at a
 * dry run before a byte is destroyed, because the failure mode of a
 * wrong orphan sweep is unrecoverable data loss.
 *
 * Off (default) ⇒ the admin route answers a bare 404, the nightly cron
 * returns before touching a lease, and NOTHING is enumerated — no
 * filesystem walk, no query. Deliberately NOT gated on
 * EVIDENCE_SUBSTRATE_ENABLED (unlike the write-side surfaces): this is a
 * delete-side hygiene pass, and the delete side never depends on the
 * write flag — bytes written while the substrate was on must stay
 * collectable after it is turned off (the sweepTenantEvidence
 * precedent). Read at call time (runtime-mutable); common layer per
 * engine-gates S5.2.
 */
export function orphanBlobGcEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_ORPHAN_BLOB_GC);
}

/**
 * Orphan-blob GC stage two — EVIDENCE_ORPHAN_BLOB_GC_DELETE.
 *
 * Promotes the sweep from report-only to actually unlinking the orphans
 * it finds. Requires EVIDENCE_ORPHAN_BLOB_GC (this flag alone does
 * nothing — the sweep does not exist). Off (default) ⇒ every run is a
 * dry run whatever the caller asks for: the admin route's `dryRun: true`
 * can only make a run MORE conservative, never less, so the flag is the
 * single authority on whether bytes may be destroyed.
 *
 * Read at call time (runtime-mutable), and read PER RUN rather than per
 * process, so an operator can flip a running deployment back to
 * report-only the moment a run reports something they did not expect.
 */
export function orphanBlobGcDeleteEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_ORPHAN_BLOB_GC_DELETE);
}

/**
 * Orphan-blob GC nightly schedule — EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED.
 *
 * Its OWN knob on top of the master flag (the SCENES_SCHEDULED_MAINTENANCE
 * idiom): the admin maintenance route is the required trigger and always
 * available while the master flag is on, whereas a pass that runs itself
 * needs a separate, deliberate decision. Off (default) ⇒ the 04:35 UTC
 * cron returns before the lease guard and issues no query.
 */
export function orphanBlobGcScheduledEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED);
}

/** Default grace window before a blob may be considered an orphan: 24 h. */
const DEFAULT_ORPHAN_GRACE_HOURS = 24;

/**
 * Orphan grace window — EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS (non-boolean).
 *
 * A blob younger than this is NEVER an orphan candidate, however
 * unreferenced it looks. The upload path has a real window in which
 * bytes exist and their row does not (put → registerAsset → scan), and a
 * sweep that raced it would delete a live upload's evidence. Generous by
 * default (24 h) because the cost of waiting is disk and the cost of
 * being wrong is destroyed evidence — this is the one knob where the
 * asymmetry is total. The same window gates the partial-write leg.
 *
 * Must be a positive integer number of hours; unset, blank, or invalid →
 * 24. Read at call time (runtime-mutable); common layer per engine-gates
 * S5.2.
 */
export function orphanBlobGcGraceHours(): number {
  const raw = process.env.EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ORPHAN_GRACE_HOURS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ORPHAN_GRACE_HOURS;
}

/** Default per-tenant deletion cap for ONE run. */
const DEFAULT_ORPHAN_MAX_DELETIONS = 500;

/**
 * Per-tenant deletion cap — EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS
 * (non-boolean).
 *
 * The blast radius of one run against one tenant. A misconfiguration
 * that makes every blob look unreferenced (a wrong tenant roster, a
 * half-migrated store) then costs at most this many blobs before an
 * operator sees the count and stops — the difference between an incident
 * and a catastrophe. The cap bounds DELETIONS, not scanning: a capped
 * run still reports every orphan it found, so the report tells the
 * operator the true size of the backlog.
 *
 * Must be a positive integer; unset, blank, or invalid → 500. Read at
 * call time (runtime-mutable); common layer per engine-gates S5.2.
 */
export function orphanBlobGcMaxDeletions(): number {
  const raw = process.env.EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ORPHAN_MAX_DELETIONS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ORPHAN_MAX_DELETIONS;
}

/** Default wall-clock budget for ONE orphan-GC run: 10 minutes. */
const DEFAULT_ORPHAN_TIME_BUDGET_MS = 10 * 60 * 1000;

/**
 * Wall-clock budget — EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS
 * (non-boolean).
 *
 * Bounds ONE run: the store walk stops when it expires and the roster
 * stops starting new tenants. Nothing is lost when it bites — an orphan
 * is rediscovered by enumeration on the next run, which is exactly why
 * this sweep needs no durable queue of its own (see the 0114 note in
 * orphan-blob-gc.service.ts).
 *
 * Must be a positive integer number of milliseconds; unset, blank, or
 * invalid → 600_000. Read at call time (runtime-mutable); common layer
 * per engine-gates S5.2.
 */
export function orphanBlobGcTimeBudgetMs(): number {
  const raw = process.env.EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ORPHAN_TIME_BUDGET_MS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ORPHAN_TIME_BUDGET_MS;
}

/**
 * Cross-flag consistency for the orphan-blob GC, dispatched from
 * validateEnv. It lives HERE, beside the three readers whose gating it
 * mirrors, rather than in the env-validation catalog: which knob depends
 * on which is defined a few lines up, and a validator that drifts from
 * its readers is worse than no validator.
 *
 * WARNINGS, not errors — every inconsistent pair here fails SAFE (the
 * sweep does less, never more), but each is an operator who thinks they
 * enabled something and did not:
 *
 *  - _DELETE or _SCHEDULED without the master flag: the sweep does not
 *    exist at all, so neither knob does anything. Worth saying out loud,
 *    because "I turned deletion on" and "nothing was ever reclaimed" is
 *    a silent pair otherwise;
 *  - the master flag with _DELETE off is NOT flagged: that is stage one
 *    working exactly as designed (report-only), and the intended state
 *    to sit in until a dry run has been read.
 */
export function validateEvidenceOrphanGcEnv(env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (envFlagEnabled(env.EVIDENCE_ORPHAN_BLOB_GC)) return;
  for (const dependent of ['EVIDENCE_ORPHAN_BLOB_GC_DELETE', 'EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED']) {
    if (envFlagEnabled(env[dependent])) {
      warnings.push(
        `${dependent} is set while EVIDENCE_ORPHAN_BLOB_GC is not — the orphan-blob ` +
          'sweep does not exist, so this knob has no effect; nothing is enumerated, ' +
          'the admin route answers 404 and the nightly pass returns immediately.',
      );
    }
  }
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
 * Fragment citations — EVIDENCE_FRAGMENT_CITATIONS (MM-zoom PR2).
 *
 * When on AND the fragment lane rendered media evidence into the prompt
 * (profile.fragmentLane), the generator's strict schema gains
 * `citedFragmentIds` and each rendered line carries its
 * `[evidence_fragment:...]` header; emitted ids resolve through
 * resolveFragmentCitations against EXACTLY the rendered set (the
 * l3-citations fence — an unrendered/hallucinated id is dropped and
 * counted, never surfaced) into fragment-arm EvidenceCitations carrying
 * assetId / capability / the RENDERED excerpt. Those citations ride the
 * supported serve in `evidenceCitations` (the L3 idiom) and let the 0113
 * capability gate pass for non-text (citedCapabilities union). Off
 * (default) ⇒ no header, no schema field, no resolver — byte-identical
 * even with the lane on. Read at call time (runtime-mutable).
 */
export function fragmentCitationsEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_FRAGMENT_CITATIONS);
}

/**
 * Raw-read gateway (Brain v2.1 MM-3) — EVIDENCE_RAW_READ_ENABLED.
 *
 * When on, EvidenceReadController serves the five raw-evidence routes
 * (asset/fragment stream + signed-URL mint, and the unauthenticated
 * redeem) behind the full gate ladder. Default off ⇒ every route answers
 * a bare 404, indistinguishable from an absent route (the
 * EPISODES_API_ENABLED idiom) — byte-identical prod. The env read lives
 * here in the common layer, NOT inside the controller (engine-gates
 * S5.2); read at call time so a flip is runtime-mutable. EVIDENCE_
 * family sits off the ENGINE flag budget by design.
 */
export function evidenceRawReadEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_RAW_READ_ENABLED);
}

/**
 * Signed-URL HMAC secret — EVIDENCE_SIGNED_URL_SECRET (non-boolean).
 *
 * Keys the HMAC-SHA256 over minted raw-evidence URL tokens. NO default,
 * deliberately: a default secret would make every deployment's tokens
 * mutually forgeable. Boot validation (env-validation.ts) hard-errors on
 * a configured-but-short (<32 chars) secret while EVIDENCE_RAW_READ_ENABLED
 * is on, and warns when the flag is on with no secret at all (the mint
 * routes then refuse 503; streaming still works). Read at call time
 * (runtime-mutable); common layer per engine-gates S5.2.
 */
export function evidenceSignedUrlSecret(): string | null {
  const raw = process.env.EVIDENCE_SIGNED_URL_SECRET;
  if (raw === undefined || raw.trim() === '') return null;
  return raw;
}

/** Default mint TTL: 300 s. (Named WITHOUT the full env-key substring so
 *  the W6 boot-capture truth gate doesn't mistake this module-scope
 *  default for a boot-captured read.) */
const DEFAULT_SIGNED_TTL = 300;

/**
 * Signed-URL lifetime — EVIDENCE_SIGNED_URL_TTL_SECONDS (non-boolean).
 *
 * Seconds a minted raw-evidence URL stays redeemable. Short by default
 * (300 s): the token is a bearer capability — expiry and the live-grant
 * re-check at redeem are its only revocation levers. Must be a positive
 * integer; unset, blank, or invalid → the 300 s default. Read at call
 * time (runtime-mutable); common layer per engine-gates S5.2.
 */
export function evidenceSignedUrlTtlSeconds(): number {
  const raw = process.env.EVIDENCE_SIGNED_URL_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SIGNED_TTL;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_SIGNED_TTL;
}

/**
 * Representation embeddings — EVIDENCE_FRAGMENT_EMBEDDINGS.
 *
 * When on, the ONE write seam (EvidenceStoreService.addRepresentation)
 * embeds the TEXT content of a representation whose writer asked for it
 * (`embedContent`) and stores the vector in
 * `derived_representation.embedding` together with its
 * `embeddingSpaceId` — the producer the 0109 column has been waiting
 * for ("WRITE-DEAD in v1"), and therefore the fragment lane's dense leg,
 * which degrades to empty by construction while the column is null.
 *
 * Off (default) ⇒ the embedder is NEVER called and NEITHER key is
 * written — the row is byte-identical to today's. An embedding failure
 * is soft: the row is written without the vector and the caller's
 * processing run still succeeds (a model hiccup must not lose derived
 * text). Read at call time (runtime-mutable); common layer per
 * engine-gates S5.2. EVIDENCE_ family sits off the ENGINE flag budget by
 * design (a substrate builder, not an engine fork).
 */
export function fragmentEmbeddingsEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_FRAGMENT_EMBEDDINGS);
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

/**
 * Local OCR processor — EVIDENCE_OCR_ENABLED.
 *
 * When on, OcrAdapter offers the 'ocr' capability for image assets: a
 * fully local tesseract.js (WASM) recognition pass whose per-region text
 * lands as fragment-anchored derived representations. Off (default) the
 * adapter's `accepts()` returns false BEFORE any engine is touched, so
 * the broker records the same `no installed processor` denial it records
 * today and NOTHING about a dispatch changes — byte-identical prod.
 *
 * Why this capability carries a flag when its two sibling adapters (image
 * metadata, document text) do not: those are header/parse-level decodes
 * measured in milliseconds, while OCR spins a worker thread, faults in a
 * ~3.5 MB WASM core plus a ~3 MB language model, and burns CPU
 * proportional to pixel count. That is an operator's capacity decision,
 * not a packaging one, so it gets an explicit switch on top of the
 * existing ladder (pack declaration → modality consent → quarantine →
 * EVIDENCE_PROCESSOR_BROKER), never instead of it.
 *
 * Read at call time (runtime-mutable) so the switch needs no restart;
 * env read lives here in the common layer per engine-gates S5.2.
 * EVIDENCE_ family sits off the ENGINE flag budget by design.
 */
export function evidenceOcrEnabled(): boolean {
  return envFlagEnabled(process.env.EVIDENCE_OCR_ENABLED);
}

/** Default OCR language set. (Named WITHOUT the full env-key substring so
 *  the W6 boot-capture truth gate doesn't mistake this module-scope
 *  default for a boot-captured read.) */
const DEFAULT_OCR_LANGS = 'eng';

/**
 * OCR language set — EVIDENCE_OCR_LANGS (non-boolean).
 *
 * A `+`- or `,`-separated list of tesseract language codes, in PRIORITY
 * ORDER (tesseract treats the first as primary, so the order is
 * meaningful and is deliberately NOT sorted). Only languages whose
 * traineddata ships in the image are accepted — ocr-assets.ts refuses
 * anything else rather than letting the engine reach a CDN for it. Unset
 * or blank ⇒ 'eng'.
 *
 * This is an OUTPUT knob (a different language set recognises different
 * characters), so it rides the adapter's configParts() fingerprint: an
 * operator who adds Russian forks the idempotency key and every asset is
 * re-read under the new key instead of silently keeping stale English-
 * only text. Read at call time; common layer per engine-gates S5.2.
 */
export function evidenceOcrLanguages(): string[] {
  const raw = process.env.EVIDENCE_OCR_LANGS;
  const source = raw === undefined || raw.trim() === '' ? DEFAULT_OCR_LANGS : raw;
  const seen: string[] = [];
  for (const part of source.split(/[+,]/)) {
    const code = part.trim().toLowerCase();
    if (code !== '' && !seen.includes(code)) seen.push(code);
  }
  return seen;
}

/** Default OCR word-confidence floor, on tesseract's 0..100 scale.
 *  (Named WITHOUT the full env-key substring — see above.) */
const DEFAULT_OCR_CONFIDENCE_FLOOR = 60;

/**
 * OCR confidence floor — EVIDENCE_OCR_MIN_CONFIDENCE (non-boolean),
 * an integer on tesseract's own 0..100 per-word scale.
 *
 * THE POINT OF THE KNOB. An OCR engine always returns SOMETHING: run it
 * over a photo of a wall and it emits plausible-looking characters with
 * confidences in the teens. Storing those would put invented text into a
 * memory that later cites it as observed evidence — the exact failure a
 * provenance-first plane exists to prevent. Words scoring below this
 * floor are therefore DROPPED from the emitted text and the drop is
 * STATED in the region's content (never silently swallowed), and a
 * region left with nothing is not written at all.
 *
 * 60 by default: tesseract's own documentation treats ~60 as the boundary
 * between a confident read and a guess, and on the synthesised fixtures
 * clean rendered text scores 80-95 while noise scores well under 40.
 *
 * An output knob ⇒ it rides configParts(), so retuning it forks the
 * idempotency key and re-reads instead of leaving differently-filtered
 * text under an unchanged key. Must be an integer in 0..100; unset,
 * blank, or invalid → 60. Read at call time; common layer per
 * engine-gates S5.2.
 */
export function evidenceOcrMinConfidence(): number {
  const raw = process.env.EVIDENCE_OCR_MIN_CONFIDENCE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_OCR_CONFIDENCE_FLOOR;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : DEFAULT_OCR_CONFIDENCE_FLOOR;
}
