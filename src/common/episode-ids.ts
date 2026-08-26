/**
 * The ONE episode-grounding union idiom (window-deriver.service.ts:876,
 * replicated verbatim by every summary stamper of the evidence plane):
 * union of the members' `source.episodeIds`, each value String()-coerced
 * and filtered to the 'episode:' record prefix (source is FLEXIBLE —
 * shapes are never guaranteed), deduped with member order preserved
 * (Set insertion order), capped at 64.
 *
 * Pure module — importable from the compaction runners, the admin
 * composers, and the provenance walker alike.
 */
export function unionEpisodeIds(memberEpisodeIds: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const list of memberEpisodeIds) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const id = String(raw);
      if (id.startsWith('episode:')) out.add(id);
    }
  }
  return [...out].slice(0, 64);
}
