/**
 * Update-story rendering internals (V10 §2) — pure helpers for
 * profile.updateStoryRendering.
 *
 * The v9lifecycle diagnosis: BEAM knowledge_update golds ask for the
 * update STORY (old value + new value), and the bitemporal closure
 * hides the old one at asOf — write-side lifecycle made the row WORSE
 * because reads only ever saw the winner. The fix restores the story
 * WITHOUT re-including superseded rows in retrieval: the winner's
 * rendered fact line carries a compact history suffix built from the
 * reverse supersededBy links ("previously: <value> — until <date>").
 * Retrieval, ranking and citations are untouched — this is prompt
 * augmentation only, applied to the SAME lines the generator and the
 * verifier read.
 *
 * Pure module — no DI, no IO, no env.
 */
import { lineFactId, type Citation } from './fact-index';

/** History entries rendered per fact line (immediate predecessor plus
 *  up to two earlier beats — the KU golds ask old vs new, not a full
 *  archaeology). */
const MAX_STORY_ENTRIES = 3;

/** Per-entry char cap on the predecessor's text. */
const STORY_OBJ_CHAR_CAP = 120;

export interface PreviousValue {
  /** The superseded row's object (the old value). */
  object: string;
  /** When the old value stopped being current (loser validUntil =
   *  winner validFrom under the resolver contract). */
  validUntil?: string | undefined;
}

function toDay(value?: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t) || t === 0) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Render one fact's history suffix. Entries arrive most-recent-first
 * (depth order of the reverse-link walk); the first is "previously",
 * the rest "earlier".
 */
export function renderUpdateStory(prevs: readonly PreviousValue[]): string {
  const parts = prevs
    .slice(0, MAX_STORY_ENTRIES)
    .map((p, i) => {
      const label = i === 0 ? 'previously' : 'earlier';
      const obj =
        p.object.length > STORY_OBJ_CHAR_CAP
          ? `${p.object.slice(0, STORY_OBJ_CHAR_CAP - 1)}…`
          : p.object;
      const until = toDay(p.validUntil);
      return `${label}: ${obj}${until ? ` — until ${until}` : ''}`;
    })
    .filter((s) => s.length > 0);
  // Parenthesised like the grounding quote: on a fact line only the
  // opening `[f<n>]` handle is a citation, and the generator copies
  // whatever else stands in brackets.
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/**
 * Append rendered history suffixes onto the matching fact lines. A line
 * opens with `[<handle>] ` (the buildFactIndex contract) and the maps are
 * keyed by fact id, so the handle resolves through the index; unmatched
 * lines pass through byte-identical. Module-private — external callers
 * compose through applyFactSuffixes.
 */
function appendUpdateStories(
  factLines: readonly string[],
  stories: ReadonlyMap<string, string>,
  factIndex: ReadonlyMap<string, Citation>,
): string[] {
  if (stories.size === 0) return [...factLines];
  return factLines.map((line) => {
    const id = lineFactId(line, factIndex);
    const suffix = id ? stories.get(id) : undefined;
    return suffix ? line + suffix : line;
  });
}

/**
 * Apply a sequence of fact-line suffix maps — update stories (V10 §2),
 * grounding quotes (multiworld §10 facts-as-keys) — in order. Absent
 * and empty maps are skipped, so callers pass their profile-gated maps
 * unconditionally; both prompts read the same augmented lines
 * (evidence parity by construction). `factIndex` is the index the lines
 * were rendered from — it resolves each line's handle to the id the maps
 * are keyed by.
 */
export function applyFactSuffixes(
  factLines: readonly string[],
  maps: ReadonlyArray<ReadonlyMap<string, string> | undefined>,
  factIndex: ReadonlyMap<string, Citation>,
): string[] {
  let lines = [...factLines];
  for (const m of maps) {
    if (m && m.size > 0) lines = appendUpdateStories(lines, m, factIndex);
  }
  return lines;
}
