/**
 * The admin migrations view reads a tenant's ledger without provisioning or
 * migrating it (src/db/migration-ledger-read.ts): nothing is DEFINEd, and a
 * namespace, database or ledger table that does not exist reads as nothing
 * applied rather than an error SurrealDB 3.x would raise on `use()`.
 */
import { readMigrationLedgerIds } from '../src/db/migration-ledger-read';

function fakeConn(world: { ns?: boolean; db?: boolean; table?: boolean; ids?: string[] }) {
  const sqls: string[] = [];
  const uses: unknown[] = [];
  const conn = {
    async use(target: unknown) {
      uses.push(target);
    },
    async query<T>(sql: string): Promise<T> {
      sqls.push(sql);
      if (sql === 'INFO FOR ROOT') return [{ namespaces: world.ns ? { brain: '' } : {} }] as T;
      if (sql === 'INFO FOR NS') return [{ databases: world.db ? { co_t: '' } : {} }] as T;
      if (sql === 'INFO FOR DB') {
        return [{ tables: world.table ? { schema_migrations: '' } : {} }] as T;
      }
      if (sql.startsWith('SELECT migrationId FROM schema_migrations')) {
        return [(world.ids ?? []).map((migrationId) => ({ migrationId }))] as T;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { conn, sqls, uses };
}

describe('readMigrationLedgerIds', () => {
  it('returns the applied ids, sorted', async () => {
    const { conn, sqls } = fakeConn({ ns: true, db: true, table: true, ids: ['0002', '0001'] });
    await expect(readMigrationLedgerIds(conn as never, 'brain', 'co_t')).resolves.toEqual([
      '0001',
      '0002',
    ]);
    expect(sqls.some((s) => /DEFINE|CREATE|UPDATE|DELETE/.test(s))).toBe(false);
  });

  it.each([
    ['namespace', { ns: false }],
    ['database', { ns: true, db: false }],
    ['ledger table', { ns: true, db: true, table: false }],
  ])('a missing %s reads as nothing applied, without creating it', async (_what, world) => {
    const { conn, sqls, uses } = fakeConn(world);
    await expect(readMigrationLedgerIds(conn as never, 'brain', 'co_t')).resolves.toEqual([]);
    expect(sqls.some((s) => /DEFINE/.test(s))).toBe(false);
    // Never selects a database that is not there.
    if (!world.ns) expect(uses).toEqual([]);
  });
});
