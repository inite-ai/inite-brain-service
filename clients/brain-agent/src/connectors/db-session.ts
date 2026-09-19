/**
 * One read-only session over a database named by a DSN — Postgres,
 * MySQL / MariaDB or SQLite — behind one tiny interface: a query with
 * `?` placeholders, rows as plain objects, close. The drivers are not
 * dependencies of the agent: `pg` and `mysql2` are imported when a DSN
 * asks for them (install them beside the agent), SQLite is Node's own
 * `node:sqlite` (22.13+). Every session is read-only at the database:
 * the connector never writes, and the database enforces it too.
 */
export type Dialect = 'postgres' | 'mysql' | 'sqlite';

export type Row = Record<string, unknown>;

export interface DbSession {
  readonly dialect: Dialect;
  /** `?` placeholders in `sql`, positional `params`. */
  query(sql: string, params: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

/** The dialect a DSN names, by its scheme — `sqlite:` / `file:` take a path. */
export function dialectOf(dsn: string): Dialect {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(dsn.trim());
  const scheme = (m?.[1] ?? '').toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  if (scheme === 'sqlite' || scheme === 'file' || scheme === '') return 'sqlite';
  throw new Error(`unsupported database scheme "${scheme}" — postgres://, mysql:// or sqlite:<path>`);
}

/** The SQL identifier quote of a dialect. */
export function quoteIdent(dialect: Dialect, ident: string): string {
  const q = dialect === 'mysql' ? '`' : '"';
  return ident
    .split('.')
    .map((part) => `${q}${part.replace(new RegExp(q, 'g'), q + q)}${q}`)
    .join('.');
}

export async function openSession(dsn: string): Promise<DbSession> {
  const dialect = dialectOf(dsn);
  if (dialect === 'sqlite') return openSqlite(dsn);
  if (dialect === 'postgres') return openPostgres(dsn);
  return openMysql(dsn);
}

/** `sqlite:/abs/path.db`, `sqlite:relative.db`, `file:/abs/path.db` or a bare path. */
function sqlitePath(dsn: string): string {
  const raw = dsn.trim().replace(/^(sqlite|file):(\/\/)?/i, '');
  const noQuery = raw.split('?')[0] ?? raw;
  if (!noQuery) throw new Error('a sqlite DSN names a file: sqlite:/path/to/db.sqlite');
  return decodeURIComponent(noQuery);
}

async function openSqlite(dsn: string): Promise<DbSession> {
  let mod: typeof import('node:sqlite');
  try {
    mod = await import('node:sqlite');
  } catch {
    throw new Error('sqlite needs Node 22.13+ (node:sqlite)');
  }
  const db = new mod.DatabaseSync(sqlitePath(dsn), { readOnly: true });
  return {
    dialect: 'sqlite',
    async query(sql, params) {
      const stmt = db.prepare(sql);
      return stmt.all(...(params as Array<null | number | bigint | string | Uint8Array>)) as Row[];
    },
    async close() {
      db.close();
    },
  };
}

interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

interface PgModuleLike {
  Client: new (opts: { connectionString: string }) => PgClientLike;
}

async function openPostgres(dsn: string): Promise<DbSession> {
  let pg: PgModuleLike;
  try {
    pg = (await import('pg' as string)) as PgModuleLike;
  } catch {
    throw new Error('postgres needs the "pg" package beside the agent: npm i -g pg');
  }
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await client.query('SET statement_timeout = 60000');
  return {
    dialect: 'postgres',
    async query(sql, params) {
      let n = 0;
      const { rows } = await client.query(
        sql.replace(/\?/g, () => `$${++n}`),
        params,
      );
      return rows;
    },
    close: () => client.end(),
  };
}

interface MysqlConnLike {
  query(sql: string, params?: unknown[]): Promise<[Row[], unknown]>;
  end(): Promise<void>;
}

interface MysqlModuleLike {
  createConnection(opts: { uri: string; timezone: string }): Promise<MysqlConnLike>;
}

async function openMysql(dsn: string): Promise<DbSession> {
  let mysql: MysqlModuleLike;
  try {
    mysql = (await import('mysql2/promise' as string)) as MysqlModuleLike;
  } catch {
    throw new Error('mysql needs the "mysql2" package beside the agent: npm i -g mysql2');
  }
  const conn = await mysql.createConnection({ uri: dsn.replace(/^mariadb:/i, 'mysql:'), timezone: 'Z' });
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  return {
    dialect: 'mysql',
    async query(sql, params) {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    close: () => conn.end(),
  };
}
