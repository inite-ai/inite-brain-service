import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';

/**
 * The record that a user was forgotten, and the rule every later write
 * for that user is held to.
 *
 * WHY. `POST /v1/users/:userId/forget` erases what exists at that moment.
 * Work accepted earlier can still be running: a mention's extraction in
 * the background (INGEST_MENTION_VIA_DOCUMENT), a request whose client
 * timed out while the server kept going, a job that read the user's rows
 * before the erase. When it finishes it writes the person back. So the
 * forget leaves a per-tenant tombstone (`user_tombstone`, migration 0200)
 * and the write paths ask it before they write.
 *
 * THE RULE. Work is dropped when it was ACCEPTED at or before the latest
 * forget: `acceptedAt <= forgottenAt`. Work accepted after it is written
 * normally. That is the re-consent rule, chosen on purpose: Brain does
 * not decide consent, the product does (`@inite/knowledge` holds writes
 * behind its own consent gate), so a person who comes back and agrees
 * again is written again without any marker, and a product that must
 * erase again sends a fresh forget, which moves `forgottenAt` forward.
 *
 * ACCEPTED AT. When the work entered Brain: the request's arrival (the
 * correlation middleware opens the scope), a job's claim (the dispatcher
 * opens it), and for a stored document's extraction the document's own
 * `createdAt`, whichever is earlier. Outside any scope (boot, a cron
 * tick) there is nothing accepted before a forget, so nothing is dropped.
 *
 * WHAT IS KEPT. The record key is an HMAC of `<companyId>/user:<userId>`
 * under FORGET_HMAC_KEY (the key `forgotten_entity` tombstones use), and
 * the row holds the time. No user id, no content.
 *
 * COST. One indexed point read per unit of work for a user-scoped write,
 * memoised for MEMO_TTL_MS per (tenant, user) in this process; a forget
 * on this process clears its own entry at once. A forget on another
 * replica is seen within MEMO_TTL_MS.
 */

/** Minimal query surface (a scoped connection or the retrying wrapper). */
export interface TombstoneDb {
  query<T>(sql: string, params?: Record<string, unknown>): Promise<T>;
}

/** The machine code a refused in-flight request answers with. */
export const USER_FORGOTTEN = 'user_forgotten';

const acceptedScope = new AsyncLocalStorage<Date>();

/** Run `fn` as work accepted at `at` (request arrival, job claim). */
export function runAccepted<T>(at: Date, fn: () => T): T {
  return acceptedScope.run(at, fn);
}

/** When the running work was accepted, or undefined outside any scope. */
export function acceptedAt(): Date | undefined {
  return acceptedScope.getStore();
}

/** The earliest of the known acceptance times. */
export function earliest(...dates: Array<Date | undefined>): Date | undefined {
  let out: Date | undefined;
  for (const d of dates) {
    if (d && !Number.isNaN(d.getTime()) && (!out || d < out)) out = d;
  }
  return out;
}

export function userTombstoneKey(companyId: string, userId: string): string {
  const key = process.env.FORGET_HMAC_KEY ?? 'inite-brain-default';
  return createHmac('sha256', key).update(`${companyId}/user:${userId}`).digest('hex');
}

const MEMO_TTL_MS = 2_000;
const MEMO_MAX = 10_000;
const memo = new Map<string, { at: number; forgottenAt: Date | null }>();

/** Test seam and the forget's own invalidation. */
export function clearTombstoneMemo(companyId?: string, userId?: string): void {
  if (companyId === undefined || userId === undefined) memo.clear();
  else memo.delete(userTombstoneKey(companyId, userId));
}

/** Write (or move forward) the user's tombstone. Returns the forget time. */
export async function recordUserTombstone(
  db: TombstoneDb,
  companyId: string,
  userId: string,
): Promise<Date> {
  const userKey = userTombstoneKey(companyId, userId);
  const forgottenAt = new Date();
  // The HMAC is the record key: a point write, never an UPDATE … WHERE.
  await db.query(`UPSERT type::record('user_tombstone', $k) SET forgottenAt = $at`, {
    k: userKey,
    at: forgottenAt,
  });
  memo.set(userKey, { at: Date.now(), forgottenAt });
  return forgottenAt;
}

/** The user's latest forget, or null. */
export async function userForgottenAt(
  db: TombstoneDb,
  companyId: string,
  userId: string,
): Promise<Date | null> {
  const userKey = userTombstoneKey(companyId, userId);
  const hit = memo.get(userKey);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.forgottenAt;
  const [rows] = await db.query<[Array<{ forgottenAt: string | Date }>]>(
    `SELECT forgottenAt FROM type::record('user_tombstone', $k)`,
    { k: userKey },
  );
  const raw = (rows ?? [])[0]?.forgottenAt;
  const forgottenAt = raw ? new Date(raw) : null;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(userKey, { at: Date.now(), forgottenAt });
  return forgottenAt;
}

/**
 * True when this work must not write for `userId`: the user has a
 * tombstone and the work was accepted at or before it. Tenant-global
 * work (no userId) and work with no known acceptance time never are.
 * The acceptance time is the scope's (runAccepted); a caller that knows
 * an earlier one opens a narrower scope around the call.
 */
export async function acceptedBeforeForget(
  db: TombstoneDb,
  companyId: string,
  userId: string | undefined,
): Promise<boolean> {
  const accepted = acceptedAt();
  if (!userId || !accepted) return false;
  const forgottenAt = await userForgottenAt(db, companyId, userId);
  return forgottenAt !== null && accepted.getTime() <= forgottenAt.getTime();
}
