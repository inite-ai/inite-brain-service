import { Logger } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import { isReadConflict } from './surreal.service';

/**
 * Schema migrator — versioned, append-only DDL applied per tenant DB.
 *
 * Why migrations and not "apply schema.surql at boot":
 *   - Breaking changes: a `DEFINE FIELD ... TYPE int` that used to be
 *     `option<int>` is fine on a fresh DB but rejects existing rows on
 *     an old tenant. We need to be able to ship that change behind a
 *     numbered file and re-apply only on tenants that haven't seen it.
 *   - Auditing: ops needs to answer "which version of the schema is
 *     this tenant on?" Today the answer is a guess. With migrations,
 *     it's a SELECT.
 *   - Reproducibility: replay a tenant from event log on a fresh DB
 *     and you should converge on the same schema. Numbered migrations
 *     are how every migration tool from Rails on does that.
 *
 * Layout:
 *   - src/db/migrations/NNNN_description.surql — applied in numeric order
 *   - schema_migrations table tracks what was applied (migrationId, name,
 *     appliedAt). The bootstrap DDL for that table is the only thing we
 *     run unconditionally.
 *
 * Concurrency: applications are caller-serialized through SurrealService's
 * schema queue, so we don't repeat that here. Within a single tenant, the
 * apply loop is sequential — IF NOT EXISTS DDL must be idempotent because
 * a partially-applied migration that retries shouldn't fail.
 */

export interface Migration {
  id: string; // "0001"
  name: string; // "0001_baseline.surql"
  sql: string;
}

export interface MigrationResult {
  applied: string[]; // migration IDs newly applied this run
  alreadyApplied: string[]; // migration IDs already present
}

const SCHEMA_MIGRATIONS_DDL = `
DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS migrationId ON schema_migrations TYPE string;
DEFINE FIELD IF NOT EXISTS name        ON schema_migrations TYPE string;
DEFINE FIELD IF NOT EXISTS appliedAt   ON schema_migrations TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS schema_migrations_id_idx ON schema_migrations FIELDS migrationId UNIQUE;
`;

const FILE_NAME = /^(\d{4})_.+\.surql$/;

export class SchemaMigrator {
  private readonly logger = new Logger(SchemaMigrator.name);
  private cached: Migration[] | null = null;

  constructor(private readonly migrationsDir: string) {}

  /** Apply all pending migrations against `conn`. */
  async migrate(conn: Surreal): Promise<MigrationResult> {
    await conn.query(SCHEMA_MIGRATIONS_DDL);

    const manifest = await this.loadManifest();
    const applied = new Set(await this.fetchAppliedIds(conn));

    const pending = manifest.filter((m) => !applied.has(m.id));
    if (pending.length === 0) {
      return {
        applied: [],
        alreadyApplied: manifest.map((m) => m.id),
      };
    }

    for (const m of pending) {
      this.logger.log(`Applying ${m.name}`);
      // Migrations defining NS-level objects (DEFINE USER brain_caller in
      // 0005, function definitions in 0003/0006) race against each other
      // when multiple tenants apply schema in parallel — SurrealDB's
      // optimistic-concurrency aborts one with `Transaction read conflict`.
      // Retry up to 5x with exponential backoff; the second attempt sees
      // the racing committer's row and the IF NOT EXISTS / OVERWRITE
      // guards make it a clean no-op.
      let attempts = 0;
      const maxAttempts = 5;
       
      while (true) {
        try {
          await conn.query(m.sql);
          break;
        } catch (err) {
          attempts++;
          if (!isReadConflict(err) || attempts >= maxAttempts) {
            this.logger.error(
              `Migration ${m.name} failed after ${attempts} attempt(s): ${(err as Error).message}`,
            );
            throw new Error(
              `Migration ${m.name} failed: ${(err as Error).message}`,
            );
          }
          const baseMs = 20 * Math.pow(2, attempts - 1);
          await new Promise((r) => setTimeout(r, baseMs + Math.random() * baseMs));
        }
      }
      await conn.query(
        `CREATE schema_migrations CONTENT { migrationId: $id, name: $name }`,
        { id: m.id, name: m.name },
      );
    }

    return {
      applied: pending.map((m) => m.id),
      alreadyApplied: [...applied],
    };
  }

  /** Load + cache migrations from disk. */
  async loadManifest(): Promise<Migration[]> {
    if (this.cached) return this.cached;
    const files = await readdir(this.migrationsDir);
    const eligible = files.filter((f) => FILE_NAME.test(f)).sort();
    if (eligible.length === 0) {
      throw new Error(
        `No migration files found in ${this.migrationsDir}. Expected NNNN_description.surql`,
      );
    }
    this.cached = await Promise.all(
      eligible.map(async (name) => ({
        id: name.match(FILE_NAME)![1],
        name,
        sql: await readFile(join(this.migrationsDir, name), 'utf-8'),
      })),
    );
    // Reject duplicate IDs early — easier to debug than mid-apply.
    const ids = new Set<string>();
    for (const m of this.cached) {
      if (ids.has(m.id)) {
        throw new Error(`Duplicate migration id ${m.id} in ${this.migrationsDir}`);
      }
      ids.add(m.id);
    }
    return this.cached;
  }

  private async fetchAppliedIds(conn: Surreal): Promise<string[]> {
    const [rows] = await conn.query<[Array<{ migrationId: string }>]>(
      `SELECT migrationId FROM schema_migrations`,
    );
    return ((rows ?? []) as Array<{ migrationId: string }>).map(
      (r) => r.migrationId,
    );
  }
}
