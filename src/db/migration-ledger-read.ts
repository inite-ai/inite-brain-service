import type { Surreal } from 'surrealdb';

/**
 * Read a database's `schema_migrations` ledger without provisioning or
 * migrating anything — the read-only half the admin migrations view needs.
 *
 * Every step checks before it touches: SurrealDB 3.x errors on `use()` or
 * a query against a namespace/database that does not exist, and the point
 * of this read is to report a tenant's real state, so it must never DEFINE
 * anything into existence. A database (or a ledger table) that is not there
 * yet has applied nothing. Identifiers are backtick-quoted; the caller has
 * validated them (`co_<companyId>` with companyId `^[a-zA-Z0-9_-]+$`).
 */
export async function readMigrationLedgerIds(
  conn: Surreal,
  namespace: string,
  database: string,
): Promise<string[]> {
  // A namespace-level user (SURREALDB_AUTH_LEVEL=namespace) cannot read
  // INFO FOR ROOT; its namespace exists by construction.
  const root = await conn
    .query<[{ namespaces?: Record<string, unknown> }]>(`INFO FOR ROOT`)
    .then(([r]) => r)
    .catch(() => undefined);
  if (root !== undefined && (!root?.namespaces || !(namespace in root.namespaces))) return [];
  await conn.use({ namespace });
  const [ns] = await conn.query<[{ databases?: Record<string, unknown> }]>(`INFO FOR NS`);
  if (!ns?.databases || !(database in ns.databases)) return [];
  await conn.use({ namespace, database });
  const [db] = await conn.query<[{ tables?: Record<string, unknown> }]>(`INFO FOR DB`);
  if (!db?.tables || !('schema_migrations' in db.tables)) return [];
  const [rows] = await conn.query<[Array<{ migrationId: string }>]>(
    `SELECT migrationId FROM schema_migrations`,
  );
  return (rows ?? []).map((r) => r.migrationId).sort();
}
