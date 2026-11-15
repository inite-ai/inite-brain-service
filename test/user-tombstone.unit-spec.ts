import {
  acceptedAt,
  acceptedBeforeForget,
  clearTombstoneMemo,
  earliest,
  recordUserTombstone,
  runAccepted,
  userForgottenAt,
  userTombstoneKey,
  type TombstoneDb,
} from '../src/common/user-tombstone';

/**
 * The forget leaves a tombstone, and work accepted at or before it is
 * dropped while work accepted after it is written: the re-consent rule.
 */
/** Run the check as work accepted at `when` (undefined = outside any scope). */
function at<T>(when: Date | undefined, fn: () => Promise<T>): Promise<T> {
  return when ? runAccepted(when, fn) : fn();
}

function fakeDb(): TombstoneDb & { rows: Map<string, Date>; reads: number } {
  const rows = new Map<string, Date>();
  const db = {
    rows,
    reads: 0,
    query: async <T>(sql: string, params?: Record<string, unknown>): Promise<T> => {
      const k = String(params?.k);
      if (sql.startsWith('UPSERT')) {
        rows.set(k, params?.at as Date);
        return [[]] as unknown as T;
      }
      db.reads += 1;
      const at = rows.get(k);
      return [at ? [{ forgottenAt: at.toISOString() }] : []] as unknown as T;
    },
  };
  return db;
}

describe('user tombstone', () => {
  beforeEach(() => clearTombstoneMemo());

  it('keeps no user id: the key is an HMAC scoped to the tenant', () => {
    const k = userTombstoneKey('co_a', 'alice@example.com');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain('alice');
    expect(userTombstoneKey('co_b', 'alice@example.com')).not.toBe(k);
  });

  it('drops work accepted at or before the forget, and writes work accepted after it', async () => {
    const db = fakeDb();
    const before = new Date(Date.now() - 60_000);
    const forgottenAt = await recordUserTombstone(db, 'co_a', 'u1');
    expect(await at(before, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(true);
    expect(await at(forgottenAt, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(true);
    const after = new Date(forgottenAt.getTime() + 1);
    expect(await at(after, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(false);
  });

  it('never drops tenant-global work, another user, or work with no acceptance time', async () => {
    const db = fakeDb();
    const before = new Date(Date.now() - 60_000);
    await recordUserTombstone(db, 'co_a', 'u1');
    expect(await at(before, () => acceptedBeforeForget(db, 'co_a', undefined))).toBe(false);
    expect(await at(before, () => acceptedBeforeForget(db, 'co_a', 'u2'))).toBe(false);
    expect(await at(before, () => acceptedBeforeForget(db, 'co_b', 'u1'))).toBe(false);
    expect(await at(undefined, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(false);
  });

  it('a fresh forget moves the line forward', async () => {
    const db = fakeDb();
    const first = await recordUserTombstone(db, 'co_a', 'u1');
    await new Promise((r) => setTimeout(r, 5));
    const between = new Date();
    await new Promise((r) => setTimeout(r, 5));
    clearTombstoneMemo();
    expect(await at(between, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(false);
    const second = await recordUserTombstone(db, 'co_a', 'u1');
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(await at(between, () => acceptedBeforeForget(db, 'co_a', 'u1'))).toBe(true);
  });

  it('reads the acceptance time from the scope the request or job opened', async () => {
    const db = fakeDb();
    const before = new Date(Date.now() - 60_000);
    await recordUserTombstone(db, 'co_a', 'u1');
    expect(acceptedAt()).toBeUndefined();
    await runAccepted(before, async () => {
      expect(acceptedAt()).toBe(before);
      expect(await acceptedBeforeForget(db, 'co_a', 'u1')).toBe(true);
    });
  });

  it('memoises a lookup briefly, so one unit of work costs one read', async () => {
    const db = fakeDb();
    await userForgottenAt(db, 'co_a', 'u9');
    await userForgottenAt(db, 'co_a', 'u9');
    expect(db.reads).toBe(1);
  });

  it('earliest picks the first known time', () => {
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-02-01T00:00:00Z');
    expect(earliest(b, undefined, a)).toBe(a);
    expect(earliest(undefined)).toBeUndefined();
  });
});
