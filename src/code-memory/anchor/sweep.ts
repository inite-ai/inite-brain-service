import { reanchor, validateAnchor, type ReadFile } from './refine';
import { parseAnchor } from './symbol-id';

/**
 * Client-side anchor sweep (Phase 2b): turn a list of stored anchors into
 * verdicts by checking each against the current working tree. Pure given
 * `readFile` + a re-anchor `choose` (heuristic or LLM). The CLI sends the
 * verdicts to the server, which applies reanchor / invalidate. `ok` anchors
 * (including symbol anchors that merely moved lines) need no action.
 */

export type AnchorVerdict =
  | { anchor: string; action: 'ok' }
  | { anchor: string; action: 'reanchor'; newAnchor: string }
  | { anchor: string; action: 'invalidate'; reason: string };

/** Thrown when a suspiciously large fraction of anchors would be invalidated —
 *  the signature of a misconfigured run (CLI launched outside the repo root so
 *  every readFile misses, or a mixed anchor-format set) rather than a real mass
 *  deletion. Aborts before the CLI POSTs a tenant-wide retract. Override with
 *  `maxInvalidateRatio: 1` for a genuine large removal. */
export class SweepBlastRadiusError extends Error {}

export function buildAnchorVerdicts(opts: {
  anchors: string[];
  readFile: ReadFile;
  choose: (candidates: string[], missing: string) => string | null;
  /** Abort if > this fraction of anchors would invalidate (default 0.5). Set to
   *  1 to disable the guard for a legitimate mass removal. */
  maxInvalidateRatio?: number;
  /** Only guard once there are at least this many anchors (default 10) — a tiny
   *  set legitimately hits high ratios. */
  minAnchorsForGuard?: number;
}): AnchorVerdict[] {
  const { anchors, readFile, choose } = opts;
  const maxInvalidateRatio = opts.maxInvalidateRatio ?? 0.5;
  const minAnchorsForGuard = opts.minAnchorsForGuard ?? 10;
  const verdicts: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    const health = validateAnchor({ anchor, readFile });
    if (health === 'present') {
      verdicts.push({ anchor, action: 'ok' });
      continue;
    }
    if (health === 'file_gone') {
      verdicts.push({ anchor, action: 'invalidate', reason: 'file removed' });
      continue;
    }
    // symbol_missing — try an LLM/heuristic re-anchor before giving up.
    const { path, symbolPath } = parseAnchor(anchor);
    const source = readFile(path);
    const newAnchor =
      source && symbolPath
        ? reanchor({ source, path, missingSymbolPath: symbolPath, choose })
        : null;
    verdicts.push(
      newAnchor
        ? { anchor, action: 'reanchor', newAnchor }
        : {
            anchor,
            action: 'invalidate',
            reason: `symbol ${symbolPath ?? ''} not found`,
          },
    );
  }
  // Blast-radius guard: a run that would retract most of the tenant's anchors is
  // almost always a misconfiguration, not reality. Refuse rather than emit the
  // mass-invalidate; the operator re-runs from the right cwd or passes the
  // override once they've confirmed the removal is real.
  const invalidateCount = verdicts.filter((v) => v.action === 'invalidate').length;
  if (
    anchors.length >= minAnchorsForGuard &&
    invalidateCount / anchors.length > maxInvalidateRatio
  ) {
    throw new SweepBlastRadiusError(
      `sweep would invalidate ${invalidateCount}/${anchors.length} anchors ` +
        `(> ${Math.round(maxInvalidateRatio * 100)}%) — refusing. This usually ` +
        `means the sweep ran outside the repo root or against mismatched ` +
        `anchor formats. Re-run from the code root, or pass the override to ` +
        `confirm a real mass removal.`,
    );
  }
  return verdicts;
}

/** Cheap default re-anchor chooser: pick the current symbol sharing the longest
 *  common prefix with the missing one (covers renames like resolv→resolve and
 *  moves that keep the class). An LLM chooser can replace this. */
export function heuristicChoose(candidates: string[], missing: string): string | null {
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const c of candidates) {
    const score = commonPrefixLen(c, missing);
    if (score > bestScore) {
      bestScore = score;
      best = c;
      tied = false;
    } else if (score === bestScore && score > 0 && c !== best) {
      tied = true;
    }
  }
  // Ambiguous: two current symbols share the top prefix (e.g. get_user vs
  // get_post for a gone get_uuid) — don't guess, invalidate instead.
  if (tied) return null;
  // Require the overlap to cover a MAJORITY of the missing symbol (60%), with a
  // 4-char floor. The old `>= min(4, len)` accepted any 4-char stem, so
  // `handleFoo`→`handleBar` (prefix 6) or `get_user`→`get_post` (prefix 4)
  // would silently re-anchor to an unrelated symbol.
  const need = Math.max(4, Math.ceil(missing.length * 0.6));
  return bestScore >= need ? best : null;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}
