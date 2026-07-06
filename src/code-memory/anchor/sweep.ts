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

export function buildAnchorVerdicts(opts: {
  anchors: string[];
  readFile: ReadFile;
  choose: (candidates: string[], missing: string) => string | null;
}): AnchorVerdict[] {
  const { anchors, readFile, choose } = opts;
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
  return verdicts;
}

/** Cheap default re-anchor chooser: pick the current symbol sharing the longest
 *  common prefix with the missing one (covers renames like resolv→resolve and
 *  moves that keep the class). An LLM chooser can replace this. */
export function heuristicChoose(
  candidates: string[],
  missing: string,
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = commonPrefixLen(c, missing);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Require a meaningful overlap so unrelated symbols aren't grabbed.
  return bestScore >= Math.min(4, missing.length) ? best : null;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}
