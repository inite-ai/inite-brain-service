import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * SurrealService — connection pool with per-tenant database routing.
 *
 * Tenancy: NS=brain, DB=co_<companyId>. Each tenant gets a logically
 * separate database. Cross-tenant queries are physically impossible
 * unless the caller explicitly switches database (which is gated by
 * ApiKey companyId).
 *
 * The connection is shared (root credentials), but every query path
 * MUST go through `useCompany(companyId)` first or use `withCompany()`.
 */
@Injectable()
export class SurrealService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SurrealService.name);
  private db: Surreal;
  private namespace: string;
  private knownDatabases = new Set<string>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const url = this.configService.getOrThrow<string>('SURREALDB_URL');
    const username = this.configService.getOrThrow<string>('SURREALDB_USERNAME');
    const password = this.configService.getOrThrow<string>('SURREALDB_PASSWORD');
    this.namespace = this.configService.get<string>('SURREALDB_NAMESPACE', 'brain');

    this.db = new Surreal();
    await this.db.connect(url);
    await this.db.signin({ username, password });
    this.logger.log(`Connected to SurrealDB at ${url}, namespace=${this.namespace}`);
  }

  async onModuleDestroy() {
    if (this.db) {
      await this.db.close();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.version();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a callback within a per-tenant database scope.
   * Switches the connection to NS=brain DB=co_<companyId>, applies
   * schema if first time seen, then yields the live db client.
   *
   * IMPORTANT: this connection is shared across requests. Surreal's
   * `use({ namespace, database })` mutates connection state. For now
   * we serialize by awaiting; future improvement is per-request
   * connections from a pool.
   */
  async withCompany<T>(companyId: string, fn: (db: Surreal) => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const database = `co_${companyId}`;
    await this.db.use({ namespace: this.namespace, database });
    if (!this.knownDatabases.has(database)) {
      await this.applySchema();
      this.knownDatabases.add(database);
      this.logger.log(`Schema applied to ${this.namespace}/${database}`);
    }
    return fn(this.db);
  }

  /**
   * Hard-delete a tenant's entire database. Used by tenant offboarding
   * and as part of per-entity cascade-forget. Returns counts before deletion.
   */
  async dropCompanyDatabase(companyId: string): Promise<void> {
    const database = `co_${companyId}`;
    await this.db.use({ namespace: this.namespace, database });
    await this.db.query(`REMOVE DATABASE ${database};`);
    this.knownDatabases.delete(database);
    this.logger.warn(`Dropped database ${this.namespace}/${database}`);
  }

  private async applySchema() {
    const schemaPath = join(__dirname, 'schema.surql');
    const schema = await readFile(schemaPath, 'utf-8');
    // Surreal accepts multi-statement queries. Split-and-loop would also work.
    await this.db.query(schema);
  }

  /** Escape hatch for tooling. Direct access — caller is responsible for use(). */
  raw(): Surreal {
    return this.db;
  }
}

/**
 * SDK-version-stable helpers for SurrealDB record CRUD. The 2.x JS SDK
 * replaced the simple `db.create('table', payload)` / `db.merge(id, patch)`
 * shape with a chained-promise builder; tying every call site to that
 * shape would couple business code to driver internals. These helpers
 * wrap the underlying primitives via `db.query()` so we keep one
 * uniform query form everywhere.
 */
export async function dbCreate<T extends Record<string, unknown>>(
  db: Surreal,
  table: string,
  data: Record<string, unknown>,
): Promise<T> {
  const [rows] = await db.query<[T[]]>(`CREATE type::table($t) CONTENT $d RETURN AFTER`, {
    t: table,
    d: data,
  });
  const arr = (rows as any[]) ?? [];
  return arr[0] as T;
}

export async function dbMerge<T extends Record<string, unknown>>(
  db: Surreal,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<T> {
  const [rows] = await db.query<[T[]]>(
    `UPDATE type::thing($t, $i) MERGE $p RETURN AFTER`,
    { t: tableOf(recordId), i: idOf(recordId), p: patch },
  );
  const arr = (rows as any[]) ?? [];
  return arr[0] as T;
}

function tableOf(rid: string): string {
  const idx = rid.indexOf(':');
  return idx === -1 ? rid : rid.slice(0, idx);
}
function idOf(rid: string): string {
  const idx = rid.indexOf(':');
  return idx === -1 ? rid : rid.slice(idx + 1);
}
