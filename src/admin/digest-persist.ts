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
  await db.query(
    `DELETE conversation_digest
      WHERE conversationId = $conv AND derivedVersion = $version`,
    { conv: conversationId, version },
  );
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
