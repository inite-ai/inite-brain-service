/**
 * Brain-issued API keys — the store's lifecycle rules.
 *
 * These are the checks that decide whether a bearer token authenticates,
 * so they are exercised against a stub database rather than only through
 * the e2e path: an expired or revoked key resolving to a record would be
 * an authentication bypass.
 */
import { ApiKeyStoreService } from '../src/auth/api-key-store.service';

type Row = Record<string, unknown>;

/** Minimal SurrealService double: one table, queried by hash or id. */
class StubSurreal {
  rows: Row[] = [];
  queries: string[] = [];

  async withAdminDb<T>(fn: (db: unknown) => Promise<T>): Promise<T> {
    const db = {
      query: async (sql: string, vars: Record<string, unknown> = {}) => {
        this.queries.push(sql);
        if (sql.startsWith('CREATE')) {
          const row = { id: vars.id, ...(vars.row as Row) };
          this.rows.push(row);
          return [[row]];
        }
        if (sql.includes('WHERE keyHash') && sql.startsWith('SELECT')) {
          return [this.rows.filter((r) => r.keyHash === vars.keyHash)];
        }
        if (sql.startsWith('SELECT * FROM type::record')) {
          return [this.rows.filter((r) => r.id === vars.id)];
        }
        if (sql.startsWith('UPDATE type::record')) {
          for (const row of this.rows) if (row.id === vars.id) row.revokedAt = new Date();
          return [[]];
        }
        if (sql.startsWith('SELECT')) {
          return [this.rows.filter((r) => r.companyId === vars.companyId)];
        }
        return [[]];
      },
    };
    return fn(db);
  }
}

function makeStore() {
  const surreal = new StubSurreal();
  const store = new ApiKeyStoreService(surreal as never);
  return { store, surreal };
}

describe('ApiKeyStoreService', () => {
  it('issues a key whose plaintext is returned once and never stored', async () => {
    const { store, surreal } = makeStore();
    const issued = await store.issue({
      companyId: 'co_x',
      name: 'laptop',
      scopes: ['brain:read', 'brain:write'],
    });

    expect(issued.key).toMatch(/^brain_[0-9a-f]{48}$/);
    expect(issued.summary.prefix).toBe(issued.key.slice(0, 12));
    expect(issued.summary.scopes).toEqual(['brain:read', 'brain:write']);

    const stored = surreal.rows[0]!;
    expect(stored.keyHash).toBe(ApiKeyStoreService.hash(issued.key));
    // The secret itself appears nowhere in the row.
    expect(JSON.stringify(stored)).not.toContain(issued.key);
  });

  it('resolves an issued key to the record the guard authenticates with', async () => {
    const { store } = makeStore();
    const issued = await store.issue({
      companyId: 'co_x',
      name: 'laptop',
      scopes: ['brain:read'],
      userId: 'user_7',
    });

    const record = await store.resolve(issued.key);
    expect(record).toEqual({
      keyHash: ApiKeyStoreService.hash(issued.key),
      companyId: 'co_x',
      scopes: ['brain:read'],
      name: 'laptop',
      userId: 'user_7',
    });
  });

  it('refuses a revoked key, and does not serve it from cache afterwards', async () => {
    const { store } = makeStore();
    const issued = await store.issue({ companyId: 'co_x', name: 'ci', scopes: ['brain:read'] });
    expect(await store.resolve(issued.key)).not.toBeNull();

    expect(await store.revoke('co_x', issued.summary.id)).toBe(true);
    expect(await store.resolve(issued.key)).toBeNull();
  });

  it('refuses an expired key', async () => {
    const { store } = makeStore();
    const issued = await store.issue({
      companyId: 'co_x',
      name: 'yesterday',
      scopes: ['brain:read'],
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await store.resolve(issued.key)).toBeNull();
  });

  it('will not revoke another tenant, and says so indistinguishably', async () => {
    const { store } = makeStore();
    const issued = await store.issue({ companyId: 'co_x', name: 'k', scopes: ['brain:read'] });

    expect(await store.revoke('co_other', issued.summary.id)).toBe(false);
    expect(await store.revoke('co_x', 'no-such-id')).toBe(false);
    // Still usable — the foreign revoke was a no-op, not a partial write.
    expect(await store.resolve(issued.key)).not.toBeNull();
  });

  it('never touches the database for a token that is not ours', async () => {
    const { store, surreal } = makeStore();
    expect(await store.resolve('ik_something_else')).toBeNull();
    expect(await store.resolve('eyJhbGciOi.x.y')).toBeNull();
    expect(surreal.queries).toHaveLength(0);
  });

  it('counts only keys that can still authenticate', async () => {
    const { store } = makeStore();
    await store.issue({ companyId: 'co_x', name: 'live', scopes: ['brain:read'] });
    const revoked = await store.issue({ companyId: 'co_x', name: 'dead', scopes: ['brain:read'] });
    await store.revoke('co_x', revoked.summary.id);
    await store.issue({
      companyId: 'co_x',
      name: 'expired',
      scopes: ['brain:read'],
      expiresAt: new Date(Date.now() - 1000),
    });
    await store.issue({ companyId: 'co_other', name: 'theirs', scopes: ['brain:read'] });

    expect(await store.activeCount('co_x')).toBe(1);
  });

  it('is inert without a database, rather than throwing on the auth path', async () => {
    const store = new ApiKeyStoreService();
    expect(store.enabled()).toBe(false);
    expect(await store.resolve('brain_' + 'a'.repeat(48))).toBeNull();
    expect(await store.list('co_x')).toEqual([]);
    await expect(
      store.issue({ companyId: 'co_x', name: 'n', scopes: ['brain:read'] }),
    ).rejects.toThrow(/no database/i);
  });

  it('survives a database failure by declining, so other sources still answer', async () => {
    const surreal = {
      withAdminDb: async () => {
        throw new Error('connection refused');
      },
    };
    const store = new ApiKeyStoreService(surreal as never);
    expect(await store.resolve('brain_' + 'b'.repeat(48))).toBeNull();
  });
});
