/**
 * The SOURCE-VERSION STAMP — "at which version of the external system of
 * record was this read?".
 *
 * WHY IT EXISTS. Some domains have an external system of record that is
 * better than our copy: exact, versioned, cheap, and never wrong about
 * the past. Code has git; legal has the DMS revision; medical has the
 * study/accession in PACS; fintech has the ledger entry. For those
 * domains memory should MATERIALIZE only what is not derivable — the
 * decision, the rationale, the gotcha, the invariant, which exist in
 * prose and are lost without us — and merely POINT AT what is derivable:
 * who owns a file, which version a dependency is pinned to, what a
 * flag's default is. A derivable fact stored as timeless truth is a
 * promise to start lying the moment the source moves.
 *
 * So a derivable claim is not "dependency is 2.0.0". It is "at commit
 * abc123, dependency is 2.0.0" — a statement that stays TRUE forever,
 * and whose usefulness we can decide by comparing its stamp against the
 * source's current version.
 *
 * DELIBERATELY NOT GIT-SHAPED. `system` names the system of record,
 * `ref` the line within it (a branch, a matter, a patient), `version`
 * the exact revision read, `readAt` when we read it. A DMS revision id
 * or an EHR study id fits the same four fields with no new vocabulary.
 *
 * The stamp is pure data — no I/O, no env read — so both the server
 * (submission validation, drift sweep) and the operator-side indexers
 * share one definition and one parser.
 */

/** One reading of an external system of record. */
export interface SourceVersionStamp {
  /** The system of record: 'git', 'dms', 'ehr', 'ledger', … */
  system: string;
  /** The line within it: a branch/ref, a matter id, a study series. */
  ref: string;
  /** The exact revision the claim was derived from. */
  version: string;
  /** When the derivation read it (ISO 8601). */
  readAt: string;
}

export const SOURCE_VERSION_MAX_SYSTEM = 32;
export const SOURCE_VERSION_MAX_REF = 200;
export const SOURCE_VERSION_MAX_VERSION = 200;

/** snake/kebab-free lowercase token — the system is vocabulary, not prose. */
const SYSTEM_TOKEN = /^[a-z][a-z0-9_]{1,31}$/;

export type SourceVersionParse =
  { ok: true; stamp: SourceVersionStamp } | { ok: false; error: string };

/**
 * Parse + fence an untrusted stamp. Every field is required: a stamp
 * missing its version cannot answer the only question it exists to
 * answer, and a half-stamp that silently rode through would be worse
 * than no stamp at all (a fact that LOOKS bound to a version but is not
 * can never be swept).
 */
export function parseSourceVersionStamp(raw: unknown): SourceVersionParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'sourceVersion must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const system = r['system'];
  if (typeof system !== 'string' || !SYSTEM_TOKEN.test(system)) {
    return {
      ok: false,
      error: `sourceVersion.system must be a lowercase token of 2..${SOURCE_VERSION_MAX_SYSTEM} chars`,
    };
  }
  const ref = boundedText(r['ref'], SOURCE_VERSION_MAX_REF);
  if (ref === null) {
    return {
      ok: false,
      error: `sourceVersion.ref must be a non-empty string of at most ${SOURCE_VERSION_MAX_REF} chars`,
    };
  }
  const version = boundedText(r['version'], SOURCE_VERSION_MAX_VERSION);
  if (version === null) {
    return {
      ok: false,
      error: `sourceVersion.version must be a non-empty string of at most ${SOURCE_VERSION_MAX_VERSION} chars`,
    };
  }
  const readAt = r['readAt'];
  if (typeof readAt !== 'string' || !Number.isFinite(Date.parse(readAt))) {
    return { ok: false, error: 'sourceVersion.readAt must be an ISO 8601 datetime' };
  }
  return { ok: true, stamp: { system, ref, version, readAt: new Date(readAt).toISOString() } };
}

function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Read a stamp back off a stored `source.sourceVersion` (or a candidate
 * payload) — the same fence, so a row written by an older/looser writer
 * cannot smuggle a malformed stamp into the drift comparison.
 */
export function readSourceVersionStamp(raw: unknown): SourceVersionStamp | null {
  const parsed = parseSourceVersionStamp(raw);
  return parsed.ok ? parsed.stamp : null;
}

/**
 * Does a stamp describe the SAME line of the SAME system as `current`?
 * Drift is only meaningful within one line: a fact read on `main` says
 * nothing about `release/2.x`, and a git commit is not comparable with a
 * DMS revision at all. Facts on another line are left alone rather than
 * marked stale on a false comparison.
 */
export function sameSourceLine(a: SourceVersionStamp, b: SourceVersionStamp): boolean {
  return a.system === b.system && a.ref === b.ref;
}
