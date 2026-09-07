/**
 * Dirty-conversation trigger for the scheduled scene-maintenance pass
 * (migration 0130, SCENES_SCHEDULED_MAINTENANCE).
 *
 * Three plain SQL verbs over `scene_dirty_conversation`, deliberately NOT a
 * Nest provider: the MARK side lives in the ingest hot path
 * (EpisodeStoreService, src/ingest) and the READ/CLEAR side in the admin
 * scheduler (src/admin) — a shared injectable would force one of those two
 * module trees to import the other. This module has no DI, no env reads and
 * no logging; it takes an already-scoped connection (the caller is inside
 * `surreal.withCompany`, so the tenant fence is the caller's) and returns
 * plain values. Flag gating is the CALLER's job too — see the docblocks.
 *
 * SurrealDB 3.2.4 discipline: every statement here addresses rows by
 * PRIMARY KEY — the mark is an UPSERT on the array-literal record id, the
 * clear is a SELECT-ids → DELETE-by-id-list pair. No UPDATE or DELETE in
 * this file filters on a secondary or compound index, which is the shape
 * that silently matches nothing on the pinned server (0093 header /
 * scene-composer swap comment).
 */

/** The one connection surface these verbs need (mock-swappable in tests). */
export interface SceneDirtyDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

/** One pending conversation as read back by the scheduled pass. */
export interface DirtyConversationRow {
  /** Record id — passed straight back to the clear, never parsed. */
  id: unknown;
  conversationId: string;
  /** Bump instant; the clear's race fence compares against it server-side. */
  markedAt?: unknown;
}

/**
 * Mark ONE conversation as needing a scene rebuild. Called from the ingest
 * seam for every captured turn, so it must stay a single round trip with no
 * read-modify-write: UPSERT on the array-literal primary key collapses a
 * burst of turns on one conversation onto one row, and `createdAt` keeps
 * its DEFAULT (first-marked instant) because the SET never restates it.
 *
 * The CALLER decides whether marking happens at all — this function does no
 * flag check. With SCENES_SCHEDULED_MAINTENANCE (or the scenes master flag)
 * off, the seam must not call it, and no row is ever written.
 */
export async function markConversationDirty(
  db: SceneDirtyDb,
  conversationId: string,
): Promise<void> {
  await db.query(
    `UPSERT scene_dirty_conversation:[$conv]
       SET conversationId = $conv, markedAt = time::now()`,
    { conv: conversationId },
  );
}

/**
 * Read a BOUNDED page of pending conversations, oldest mark first — the
 * budget fence of the nightly pass. Oldest-first matters: a tenant whose
 * backlog exceeds the per-run cap drains in arrival order across successive
 * nights instead of starving its oldest conversations behind a busy one.
 */
export async function selectDirtyConversations(
  db: SceneDirtyDb,
  limit: number,
): Promise<DirtyConversationRow[]> {
  if (limit <= 0) return [];
  const [rows] = await db.query<[DirtyConversationRow[]]>(
    `SELECT id, conversationId, markedAt FROM scene_dirty_conversation
      ORDER BY markedAt ASC LIMIT $limit`,
    { limit: Math.floor(limit) },
  );
  return (rows ?? []).filter((r) => typeof r.conversationId === 'string');
}

/**
 * Clear the marks the pass actually consumed, and ONLY those.
 *
 * `readAt` must be an instant captured BEFORE the dirty page was selected.
 * A turn that lands while the (potentially long, LLM-spending) compose runs
 * bumps `markedAt` past that instant, so its row fails the fence, survives
 * the delete, and the conversation is recomposed on the next pass. The
 * asymmetry is deliberate: a redundant recompose is cheap and idempotent, a
 * dropped turn would be invisible until someone diffed the scene world.
 *
 * Two steps rather than one `DELETE … WHERE`: the id list is resolved by a
 * SELECT and the delete then addresses primary keys only (the LET-select-ids
 * idiom). Returns how many marks were actually cleared.
 */
export async function clearDirtyConversations(
  db: SceneDirtyDb,
  ids: readonly unknown[],
  readAt: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const [stale] = await db.query<[unknown[]]>(
    `SELECT VALUE id FROM scene_dirty_conversation
      WHERE id INSIDE $ids AND markedAt <= $readAt`,
    { ids: [...ids], readAt },
  );
  const doomed = stale ?? [];
  if (doomed.length === 0) return 0;
  await db.query(`DELETE scene_dirty_conversation WHERE id INSIDE $doomed`, { doomed });
  return doomed.length;
}
