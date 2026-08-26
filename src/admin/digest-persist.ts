/**
 * Digest persistence (V12 §2 write side), split out of
 * window-deriver.service.ts for the max-lines budget — the same
 * collaborator pattern as aspect-rollups.ts. Body moved verbatim from
 * the service's private persistDigest (0087 added userScopes).
 */

/** The scoped query surface the deriver hands its collaborators. */
export interface DigestDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

/**
 * Persist the digest AFTER the fold loop: replace-per-namespace
 * (derived state, rebuilt with the conversation on re-derive).
 * lastIngestAt = fold wall-clock (monotonic filter watermark for a
 * future incremental path); lastEventAt = max folded occurredAt.
 */
export async function persistDigest({
  db,
  conversationId,
  version,
  digest,
  digestEventAt,
  userScopes,
}: {
  db: DigestDb;
  conversationId: string;
  version: string;
  digest: string | null;
  digestEventAt: Date | null;
  /** 0087: folded window's distinct userIds; [] = tenant-global. */
  userScopes: string[];
}): Promise<void> {
  // Audit 2026-08-19 P1: deriving a (conversation, version) claims the
  // whole namespace — the OLD digest dies regardless of whether this
  // run produced a new one (flag now off, or the fold degraded).
  // Leaving it would serve a narrative inconsistent with the facts
  // that were just rewritten next to it.
  //
  // Two-step (SELECT ids → DELETE $ids) DELIBERATELY: this WHERE pair is
  // exactly the COMPOUND digest_conv_version_idx (conversationId,
  // derivedVersion) UNIQUE index — on SurrealDB 3.2.4 a DELETE planned
  // through a compound index can be a silent no-op (returns OK, deletes
  // nothing) while the same WHERE in a SELECT matches fine — the bug
  // class reproduced for preSweepOutcomeRows (PR #372). A no-op here
  // would collide the CREATE below into the UNIQUE pair. At most one row
  // by the UNIQUE index, so no batching.
  const [digestIds] = await db.query<[unknown[]]>(
    `SELECT VALUE id FROM conversation_digest
      WHERE conversationId = $conv AND derivedVersion = $version`,
    { conv: conversationId, version },
  );
  if (((digestIds as unknown[]) ?? []).length > 0) {
    await db.query(`DELETE $ids`, { ids: digestIds });
  }
  if (digest === null || !digest.trim() || !digestEventAt) return;
  await db.query(
    `CREATE conversation_digest SET
       conversationId = $conv, derivedVersion = $version,
       summary = $summary, lastIngestAt = time::now(),
       lastEventAt = <datetime>$eventAt, userScopes = $userScopes`,
    {
      conv: conversationId,
      version,
      summary: digest,
      eventAt: digestEventAt.toISOString(),
      userScopes,
    },
  );
}
