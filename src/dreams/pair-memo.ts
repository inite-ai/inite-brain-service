import { createHash } from 'node:crypto';
import { RecordId } from 'surrealdb';

/**
 * What a nightly judge already decided about a pair (0173). A verdict that
 * changed nothing — `different`, `unsure` — used to leave no trace, so the
 * same pairs were paid for every night (LLM spend audit, 2026-10-28).
 *
 * A pair is skipped while its memo is fresh AND the judge would see the
 * same input (`signature`); new evidence or an old memo means judge again.
 */
export type PairMemoKind = 'dedup' | 'resolve' | 'corroborate';

/** Even an unchanged pair is judged again after this long: models and prompts move. */
export const PAIR_RECHECK_MS = 30 * 24 * 3600 * 1000;

interface MemoDb {
  query<T>(sql: string, params?: Record<string, unknown>): Promise<T>;
}

export interface PairMemoRow {
  pairKey: string;
  signature: string;
  checkedAt: Date | string;
}

export function pairSignature(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export async function loadPairMemo(
  db: MemoDb,
  kind: PairMemoKind,
): Promise<Map<string, PairMemoRow>> {
  const [rows] = await db.query<[PairMemoRow[]]>(
    `SELECT pairKey, signature, checkedAt FROM dream_pair_checked WHERE kind = $kind`,
    { kind },
  );
  return new Map((rows ?? []).map((r) => [r.pairKey, r]));
}

/** True when the judge already answered this exact input recently. */
export function alreadyJudged(
  memo: Map<string, PairMemoRow>,
  { pairKey, signature }: { pairKey: string; signature: string },
  now = Date.now(),
): boolean {
  const row = memo.get(pairKey);
  if (!row || row.signature !== signature) return false;
  return now - new Date(row.checkedAt).getTime() < PAIR_RECHECK_MS;
}

export async function recordPairVerdict(
  db: MemoDb,
  row: { kind: PairMemoKind; pairKey: string; signature: string; verdict: string },
): Promise<void> {
  // Addressed by its own id, not `WHERE` over the compound index: on
  // SurrealDB 3.2.4 a write filtered only by a compound-indexed field can
  // silently match nothing (the 0106/#372 planner bug class).
  await db.query(
    `UPSERT $id SET kind = $kind, pairKey = $pairKey, signature = $signature,
       verdict = $verdict, checkedAt = time::now()`,
    { id: new RecordId('dream_pair_checked', [row.kind, row.pairKey]), ...row },
  );
}
