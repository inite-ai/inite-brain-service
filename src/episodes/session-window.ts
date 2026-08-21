/**
 * The session primitive of the episodic substrate: a SESSION is a
 * maximal run of episodes with no inactivity gap longer than
 * SESSION_GAP_MS. There is deliberately no stored sessionId
 * (migration 0073's design note) — sessionization is computed from
 * occurredAt wherever it's needed.
 *
 * Lives in the episodes layer (rank 0 of the engine layering gate,
 * S5.4) because BOTH the deriver (rank 1) and the synthesize-side
 * lanes (rank 3, e.g. the V9 mention scan) need the same convention —
 * before this move the deriver owned it and upper layers had to
 * duplicate the constant to respect the import direction.
 */

export const SESSION_GAP_MS = 60 * 60 * 1000;

export interface EpisodeRow {
  id: unknown;
  speaker?: string;
  text: string;
  occurredAt: string | Date;
  /** Per-user scope of the turn; absent = tenant-global (0087: the
   *  deriver folds these into conversation_digest.userScopes). */
  userId?: string;
}

/**
 * Pure: the distinct non-null userIds of an episode window, sorted for
 * a deterministic stamp. [] = fully tenant-global content. The window
 * deriver folds this into conversation_digest.userScopes (0087) — the
 * digest lane's fail-closed read policy keys on it.
 */
export function distinctUserScopes(episodes: EpisodeRow[]): string[] {
  return [
    ...new Set(
      episodes
        .map((e) => e.userId)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    ),
  ].sort();
}

/** Pure: split time-ordered episodes into sessions by inactivity gap. */
export function segmentSessions(
  episodes: EpisodeRow[],
  gapMs: number = SESSION_GAP_MS,
): EpisodeRow[][] {
  const sessions: EpisodeRow[][] = [];
  let current: EpisodeRow[] = [];
  let prev: number | null = null;
  for (const ep of episodes) {
    const t = new Date(ep.occurredAt as string).getTime();
    if (prev !== null && t - prev > gapMs && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    current.push(ep);
    prev = t;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}
