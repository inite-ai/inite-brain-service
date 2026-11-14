import { surrealAuthLevel } from '../src/db/surreal-auth-level';
import { readMigrationLedgerIds } from '../src/db/migration-ledger-read';

const cfg = (v?: string) => ({ get: () => v }) as never;

describe('SURREALDB_AUTH_LEVEL', () => {
  it('namespace only when asked; anything else is root', () => {
    expect(surrealAuthLevel(cfg('namespace'))).toBe('namespace');
    expect(surrealAuthLevel(cfg(' Namespace '))).toBe('namespace');
    expect(surrealAuthLevel(cfg(undefined))).toBe('root');
    expect(surrealAuthLevel(cfg('database'))).toBe('root');
  });

  it('the ledger read survives a user that may not read INFO FOR ROOT', async () => {
    const calls: string[] = [];
    const conn = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === 'INFO FOR ROOT') throw new Error('IAM error: not enough permissions');
        if (sql === 'INFO FOR NS') return [{ databases: { co_x: '' } }];
        if (sql === 'INFO FOR DB') return [{ tables: { schema_migrations: '' } }];
        return [[{ migrationId: '0002' }, { migrationId: '0001' }]];
      },
      use: async () => undefined,
    } as never;
    await expect(readMigrationLedgerIds(conn, 'inite', 'co_x')).resolves.toEqual(['0001', '0002']);
    expect(calls[0]).toBe('INFO FOR ROOT');
  });
});
