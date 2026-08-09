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
  validUntil?: string;
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
  return parts.length > 0 ? ` [${parts.join('; ')}]` : '';
}

/**
 * Append rendered history suffixes onto the matching fact lines. Lines
 * open with `[<factId>] ` (the buildFactIndex contract); unmatched
 * lines pass through byte-identical.
 */
export function appendUpdateStories(
  factLines: readonly string[],
  stories: ReadonlyMap<string, string>,
): string[] {
  if (stories.size === 0) return [...factLines];
  return factLines.map((line) => {
    if (!line.startsWith('[')) return line;
    const close = line.indexOf(']');
    if (close <= 1) return line;
    const suffix = stories.get(line.slice(1, close));
    return suffix ? line + suffix : line;
  });
}
