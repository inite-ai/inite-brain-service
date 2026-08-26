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
