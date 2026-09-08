/**
 * Scene entity links (Brain v2 PR3, SCENES_ENTITY_LINKS) — the pure half.
 *
 * The LLM enricher returns `entityMentions`: free-text names of the
 * people, places and things a scene names. The 0106 column that holds
 * them, `entityIds`, is typed `option<array<record<knowledge_entity>>>` —
 * RECORD REFS, not strings — which is exactly why PR2 parsed the mentions
 * and threw them away rather than poisoning the column's contract.
 *
 * This module owns the two decisions that need no I/O: WHICH mentions are
 * worth a lookup, and HOW the resolved ids become a stable column value.
 * The lookup itself is EntityUpsertService.resolveExistingByName (the
 * platform's own deterministic resolution, resolve-only), and the fence
 * lives with the enricher that knows the scene's scope.
 */

/**
 * Mentions attempted per scene, and therefore the cap on links a single
 * scene can carry (design constant, the SCENE_LANE_TOP_K idiom —
 * deliberately NOT an env knob until the pass is measured).
 *
 * WHY A CAP AT ALL. The parser already bounds the reply at MENTIONS_MAX =
 * 50, but each surviving mention costs one indexed lookup (up to three
 * under the article/code-alias flags), so an off-rubric model listing
 * every noun in a 40-turn scene would turn ONE enrichment into ~150
 * queries. Twelve is generous for "who and what this scene is about" and
 * keeps the resolution cost per scene an order of magnitude below the LLM
 * call that produced the mentions.
 *
 * WHY THE FIRST TWELVE and not a ranked twelve: the model emits mentions
 * in the order it found them salient, and any re-ranking we invented here
 * (length, frequency in the transcript) would be a guess dressed as a
 * signal. Truncation of a list the model itself ordered is the honest cut.
 */
export const SCENE_ENTITY_LINKS_MAX = 12;

/**
 * Pure: the mentions this scene will actually try to resolve.
 *
 * Trims, drops blanks, and de-duplicates CASE-INSENSITIVELY while keeping
 * the FIRST spelling seen — "Lisbon" and "lisbon" are one lookup, and the
 * surviving spelling is the one the model wrote first, since the exact
 * match tries `aliases CONTAINS <raw>` where case matters. Order is the
 * model's, and the list is truncated to SCENE_ENTITY_LINKS_MAX.
 */
export function selectSceneMentions(mentions: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mention of mentions) {
    if (out.length >= SCENE_ENTITY_LINKS_MAX) break;
    const name = mention.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Pure: the stable column value for a set of resolved entity ids.
 *
 * De-duplicated (two mentions of one entity — "Mika" and "mika savchenko"
 * — must not double-link it) and SORTED, so the written value is a
 * function of the resolved SET alone and not of the order the model
 * happened to list the mentions in. That is what makes a re-enrichment
 * over an unchanged corpus write a byte-identical column.
 */
export function stableEntityIds(resolved: readonly string[]): string[] {
  return [...new Set(resolved.filter((id) => id !== ''))].sort();
}
