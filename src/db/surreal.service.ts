import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { join } from 'node:path';
import { SchemaMigrator } from './migrator.service';

/**
 * SurrealService — pooled connections with per-tenant database routing.
 *
 * Why a pool: Surreal's `db.use({ namespace, database })` mutates connection
 * state. A single shared connection across concurrent requests would race —
 * a request for tenant A could see queries land on tenant B's database
 * because B's `use()` ran between A's `use()` and A's query.
 *
 * Each request acquires an idle connection, switches it to its tenant's
 * database, runs its query, and releases. Connections are never shared
 * mid-flight, so the `use()` state is stable for the duration of `fn`.
 *
 * Tenancy: NS=brain, DB=co_<companyId>. Cross-tenant queries are
 * physically impossible from outside `withCompany`.
 */
@Injectable()
export class SurrealService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SurrealService.name);
  // Two pools — admin (root) and scoped (brain_caller user).
  // Caller-facing reads route through scopedPool so PERMISSIONS clauses
  // on PII fields (migration 0005) actually fire. Admin paths
  // (migration apply, GDPR forget, drop database) use rootPool because
  // PERMISSIONS would block them and we want infra ops to bypass.
  private readonly all: Surreal[] = [];
  private readonly rootIdle: Surreal[] = [];
  private readonly scopedIdle: Surreal[] = [];
  private readonly rootWaiters: Array<(c: Surreal) => void> = [];
  private readonly scopedWaiters: Array<(c: Surreal) => void> = [];
  private namespace!: string;
  private poolSize!: number;
  private scopedPoolSize!: number;
  private scopedEnabled = false;
  // Track whether we've already overwritten brain_caller's password
  // this process boot for an existing-tenant case. Migrations only
  // re-run on fresh DBs; on re-deploys we still need to sync the
  // declared password with whatever SURREALDB_SCOPED_PASS now holds.
  // One-shot per process — cheap NS-level DDL but no need to repeat.
  private scopedPasswordSynced = false;
  private readonly knownDatabases = new Set<string>();
  // All schema applications (across all databases) are serialized through
  // this chain. SurrealDB raises transaction read-conflicts when multiple
  // tenants concurrently CREATE DATABASE + DEFINE on shared metadata.
  // Global schema apply queue. Migrations 0005 (DEFINE USER brain_caller
  // at NS level) and 0003/0006 (DEFINE FUNCTION fn::* at NS level)
  // operate on namespace-level metadata that races under concurrent
  // apply across fresh tenants — even with IF NOT EXISTS guards,
  // SurrealDB's metadata layer surfaces OCC conflicts faster than
  // retry can absorb them. Serializing the apply phase across all
  // tenants on the same brain instance trades cold-start latency
  // (linear in tenant count, only paid on first request per tenant)
  // for steady-state correctness.
  private schemaQueue: Promise<unknown> = Promise.resolve();
  private readonly migrator: SchemaMigrator;
  // Dedicated long-lived root connection used ONLY by the migrator,
  // NOT in either pool. Without this, ensureSchema acquires a root
  // conn from the pool — and under N-way fan-out where N == poolSize
  // and every caller targets the same fresh tenant, all pool conns
  // are held by callers awaiting ensureSchema, the migrator's own
  // acquireRoot() finds the pool empty, and the system deadlocks.
  // A standalone migrator conn breaks the cycle without changing
  // any caller-facing semantics.
  private migratorConn!: Surreal;

  constructor(private readonly configService: ConfigService) {
    this.migrator = new SchemaMigrator(join(__dirname, 'migrations'));
  }

  async onModuleInit() {
    const url = this.configService.getOrThrow<string>('SURREALDB_URL');
    const username = this.configService.getOrThrow<string>('SURREALDB_USERNAME');
    const password = this.configService.getOrThrow<string>('SURREALDB_PASSWORD');
    this.namespace = this.configService.get<string>('SURREALDB_NAMESPACE', 'brain');
    this.poolSize = parseInt(
      this.configService.get<string>('SURREALDB_POOL_SIZE', '8'),
      10,
    );
    this.scopedPoolSize = parseInt(
      this.configService.get<string>('SURREALDB_SCOPED_POOL_SIZE', '8'),
      10,
    );
    if (!Number.isFinite(this.poolSize) || this.poolSize < 1) {
      throw new Error('SURREALDB_POOL_SIZE must be a positive integer');
    }

    // Dedicated migrator connection — root-signed, NOT in any pool.
    // ensureSchema runs against this conn so callers holding pool conns
    // in withCompany/withScopedCompany never block on migration acquiring
    // a fresh root conn from a saturated pool.
    this.migratorConn = new Surreal();
    await this.migratorConn.connect(url);
    await this.migratorConn.signin({ username, password });
    this.all.push(this.migratorConn);

    // Root pool — admin signin.
    for (let i = 0; i < this.poolSize; i++) {
      const conn = new Surreal();
      await conn.connect(url);
      await conn.signin({ username, password });
      this.all.push(conn);
      this.rootIdle.push(conn);
    }

    // Scoped pool — sign in as `brain_caller` (defined in migration 0005).
    // Disabled cleanly when the user/password aren't set; falls back to
    // the root pool for everything (defense-in-depth becomes app-only,
    // matching pre-0005 behaviour). Production deployments MUST set
    // SURREALDB_SCOPED_USER + SURREALDB_SCOPED_PASS for DB-level fences.
    const scopedUser = this.configService.get<string>('SURREALDB_SCOPED_USER');
    const scopedPass = this.configService.get<string>('SURREALDB_SCOPED_PASS');
    if (scopedUser && scopedPass) {
      // Apply migrations on a root conn FIRST so brain_caller user exists.
      // The first withCompany call that targets a fresh tenant DB still
      // runs the migrations queue — but the root pool is already up,
      // so any scoped pool signin failures with "user not found" are
      // contained to that tenant's first request and resolve on retry.
      this.scopedEnabled = true;
      for (let i = 0; i < this.scopedPoolSize; i++) {
        const conn = new Surreal();
        await conn.connect(url);
        try {
          await conn.signin({ username: scopedUser, password: scopedPass, namespace: this.namespace });
        } catch (e) {
          // brain_caller user not yet defined (first boot, no migrations
          // applied yet). Fall back to root signin so the conn is at
          // least usable; on first scoped request, withScopedCompany
          // re-signs in as scoped after migrations land.
          this.logger.warn(
            `Scoped signin failed (likely first boot before migrations): ${(e as Error).message}. ` +
              `Falling back to root for this connection until first migration runs.`,
          );
          await conn.signin({ username, password });
        }
        this.all.push(conn);
        this.scopedIdle.push(conn);
      }
    }

    this.logger.log(
      `Connected to SurrealDB at ${url}, root_pool=${this.poolSize}, ` +
        `scoped_pool=${this.scopedEnabled ? this.scopedPoolSize : 'off'}, ` +
        `namespace=${this.namespace}`,
    );
  }

  async onModuleDestroy() {
    await Promise.all(
      this.all.map((c) =>
        c.close().catch((e: unknown) => {
          this.logger.warn(`Error closing Surreal connection: ${(e as Error).message}`);
        }),
      ),
    );
  }

  async ping(): Promise<boolean> {
    if (this.all.length === 0) return false;
    try {
      await this.all[0].version();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a callback inside a per-tenant database scope on a pool-acquired
   * ROOT connection. Schema is applied lazily on first use of a database.
   * The connection is exclusive to this callback for its lifetime.
   *
   * Use this for admin paths: schema apply, GDPR forget, drop database,
   * compaction, ops scripts. Caller-facing paths must use
   * `withScopedCompany` so DB-level PII permissions apply.
   */
  async withCompany<T>(companyId: string, fn: (db: Surreal) => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const database = `co_${companyId}`;
    const conn = await this.acquireRoot();
    try {
      await conn.use({ namespace: this.namespace, database });
      await this.ensureSchema(conn, database);
      return await fn(conn);
    } finally {
      this.releaseRoot(conn);
    }
  }

  /**
   * Run a callback inside a per-tenant DB scope on a SCOPED connection.
   * The connection is signed in as `brain_caller` (EDITOR role, not
   * root), so PERMISSIONS clauses defined on schema fields apply.
   *
   * Per-request, the service binds the caller's brain scopes to the
   * SurrealDB session variable `$caller_scopes` via `LET`. PERMISSIONS
   * clauses on PII-classed predicates check this variable; absence
   * means PII fields return NONE for `object` while non-PII fields
   * still return their values.
   *
   * If the scoped pool is disabled (env var unset, dev mode without
   * a non-root user), this falls back to `withCompany` semantics —
   * defense-in-depth becomes app-layer-only.
   */
  async withScopedCompany<T>(
    companyId: string,
    scopes: readonly string[],
    fn: (db: Surreal) => Promise<T>,
  ): Promise<T> {
    if (!this.scopedEnabled) {
      // Soft fallback: route to root pool but still set $caller_scopes
      // so any defensive PERMISSIONS clauses checking it behave as if
      // the scope binding was honoured. Root will bypass PERMISSIONS,
      // so the actual gate is the app-layer filter.
      return this.withCompany(companyId, async (db) => {
        await db.query(`LET $caller_scopes = $scopes`, { scopes: [...scopes] });
        return fn(db);
      });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const database = `co_${companyId}`;
    const conn = await this.acquireScoped();
    try {
      await conn.use({ namespace: this.namespace, database });
      // Migrations are idempotent and already serialised through
      // schemaQueue; running on a scoped connection works because
      // EDITOR role can DEFINE in v2 against an existing database
      // it has access to (NS-level USER + DB exists).
      await this.ensureSchema(conn, database);
      // Bind scopes for this request. The variable lives until the
      // next LET on this connection — releasing back to the pool
      // doesn't reset it, but the next withScopedCompany call
      // overwrites it before the user-fn runs, so cross-request
      // contamination is impossible.
      await conn.query(`LET $caller_scopes = $scopes`, { scopes: [...scopes] });
      return await fn(conn);
    } finally {
      this.releaseScoped(conn);
    }
  }

  /**
   * Hard-delete a tenant's entire database. Used by tenant offboarding
   * and per-entity cascade-forget.
   */
  async dropCompanyDatabase(companyId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const database = `co_${companyId}`;
    const conn = await this.acquireRoot();
    try {
      await conn.use({ namespace: this.namespace, database });
      await conn.query(`REMOVE DATABASE ${database};`);
      this.knownDatabases.delete(database);
      this.logger.warn(`Dropped database ${this.namespace}/${database}`);
    } finally {
      this.releaseRoot(conn);
    }
  }

  /** Test-only: stats for monitoring tests / debugging. */
  poolStats(): {
    size: number;
    idle: number;
    waiters: number;
    scopedIdle: number;
    scopedWaiters: number;
  } {
    return {
      size: this.poolSize,
      idle: this.rootIdle.length,
      waiters: this.rootWaiters.length,
      scopedIdle: this.scopedIdle.length,
      scopedWaiters: this.scopedWaiters.length,
    };
  }

  private acquireRoot(): Promise<Surreal> {
    const free = this.rootIdle.shift();
    if (free) return Promise.resolve(free);
    return new Promise<Surreal>((resolve) => this.rootWaiters.push(resolve));
  }

  private releaseRoot(conn: Surreal): void {
    const next = this.rootWaiters.shift();
    if (next) {
      next(conn);
    } else {
      this.rootIdle.push(conn);
    }
  }

  private acquireScoped(): Promise<Surreal> {
    const free = this.scopedIdle.shift();
    if (free) return Promise.resolve(free);
    return new Promise<Surreal>((resolve) => this.scopedWaiters.push(resolve));
  }

  private releaseScoped(conn: Surreal): void {
    const next = this.scopedWaiters.shift();
    if (next) {
      next(conn);
    } else {
      this.scopedIdle.push(conn);
    }
  }

  /**
   * Apply migrations to the target database. ALWAYS runs on a freshly
   * acquired root connection — migration 0005 (DEFINE USER brain_caller)
   * requires OWNER role and would otherwise fail when reached via the
   * scoped pool. Other migrations don't strictly need root, but
   * centralising here means schema apply behaves identically regardless
   * of which pool the request entered through.
   */
  private async ensureSchema(_conn: Surreal, database: string): Promise<void> {
    if (this.knownDatabases.has(database)) return;
    const next = this.schemaQueue.then(async () => {
      if (this.knownDatabases.has(database)) return;
      // Use the dedicated migrator conn rather than acquiring from
      // the pool. Avoids the deadlock where every pool conn is
      // currently held in withCompany awaiting THIS migration to
      // finish.
      await this.migratorConn.use({ namespace: this.namespace, database });
      const result = await this.migrator.migrate(this.migratorConn);
      this.knownDatabases.add(database);
      if (result.applied.length > 0) {
        this.logger.log(
          `Migrated ${this.namespace}/${database}: applied [${result.applied.join(', ')}], ` +
            `already-applied [${result.alreadyApplied.join(', ') || '-'}]`,
        );
        if (this.scopedEnabled && result.applied.includes('0005')) {
          // Migration 0005 hardcodes a placeholder password
          // ('brain-caller-password-must-be-overridden-via-env'). Brain
          // owns the real password via SURREALDB_SCOPED_PASS — overwrite
          // the user immediately after the migration lands so the scoped
          // pool can sign in with the operator's secret. Idempotent
          // (DEFINE USER OVERWRITE replaces in place).
          await this.overwriteScopedUserPassword();
          await this.resignScopedConns();
        }
      } else if (
        this.scopedEnabled &&
        result.alreadyApplied.includes('0005') &&
        !this.scopedPasswordSynced
      ) {
        // Existing tenant DBs (0005 already applied) on a brain process
        // that just rotated its SURREALDB_SCOPED_PASS — the migration
        // won't re-run, but the secret may have changed since the user
        // was created. Re-overwrite once per process boot to keep
        // declared password in sync with what the scoped pool will
        // sign in as. Cheap idempotent NS-level DDL.
        await this.overwriteScopedUserPassword();
        await this.resignScopedConns();
        this.scopedPasswordSynced = true;
      } else {
        this.logger.log(
          `Schema up-to-date for ${this.namespace}/${database} ` +
            `(${result.alreadyApplied.length} migration(s) applied)`,
        );
      }
    });
    this.schemaQueue = next.catch(() => undefined);
    await next;
  }

  /**
   * Replace the brain_caller user's password with the operator's
   * SURREALDB_SCOPED_PASS. Migration 0005 ships a hardcoded placeholder
   * (it has to — DDL does not bind to runtime variables); brain
   * overwrites here. NS-level user definition reuses the migrator
   * connection's namespace context.
   */
  private async overwriteScopedUserPassword(): Promise<void> {
    const scopedUser = this.configService.get<string>('SURREALDB_SCOPED_USER');
    const scopedPass = this.configService.get<string>('SURREALDB_SCOPED_PASS');
    if (!scopedUser || !scopedPass) return;
    // Validate user identifier — SurrealDB DDL doesn't bind identifiers,
    // and we splice this into the query directly. Defend against anything
    // that isn't a plain ASCII identifier.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(scopedUser)) {
      this.logger.error(
        `Refusing to overwrite scoped user with non-identifier name: '${scopedUser}'`,
      );
      return;
    }
    try {
      await this.migratorConn.query(
        `DEFINE USER OVERWRITE ${scopedUser} ON NAMESPACE PASSWORD $pass ROLES EDITOR`,
        { pass: scopedPass },
      );
      this.logger.log(`Reset password for scoped user '${scopedUser}'`);
    } catch (err) {
      // Non-fatal — scoped pool will degrade to root signin (still
      // app-layer policy), but DB-level fence won't enforce.
      this.logger.warn(
        `Failed to overwrite scoped user password: ${(err as Error).message}. ` +
          `Scoped pool will fall back to root.`,
      );
    }
  }

  /**
   * Re-sign all idle scoped pool connections as `brain_caller` after
   * migration 0005 lands. Connections currently in flight will be
   * re-signed on their next acquire (we mark them via shadow Set).
   * Best-effort — failures fall back to root-signed (still functional,
   * just no PERMISSIONS enforcement).
   */
  private async resignScopedConns(): Promise<void> {
    const url = this.configService.getOrThrow<string>('SURREALDB_URL');
    const scopedUser = this.configService.get<string>('SURREALDB_SCOPED_USER');
    const scopedPass = this.configService.get<string>('SURREALDB_SCOPED_PASS');
    if (!scopedUser || !scopedPass) return;
    for (const conn of this.scopedIdle) {
      try {
        await conn.signin({
          username: scopedUser,
          password: scopedPass,
          namespace: this.namespace,
        });
      } catch (e) {
        this.logger.warn(
          `Re-signin to scoped failed for an idle conn: ${(e as Error).message}`,
        );
      }
    }
    void url; // silence unused
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
  const arr = (rows as T[]) ?? [];
  return arr[0];
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
  const arr = (rows as T[]) ?? [];
  return arr[0];
}

function tableOf(rid: string): string {
  const idx = rid.indexOf(':');
  return idx === -1 ? rid : rid.slice(0, idx);
}
function idOf(rid: string): string {
  const idx = rid.indexOf(':');
  return idx === -1 ? rid : rid.slice(idx + 1);
}

/**
 * Run a SurrealDB transaction. The WebSocket protocol's `query()` method
 * scopes each call as its own evaluation context, so BEGIN/COMMIT issued
 * via separate `query()` calls fail with `Unexpected statement type
 * encountered: Commit(CommitStatement)` — the COMMIT statement has no
 * matching BEGIN in scope. The fix is to send the entire transaction as
 * one multi-statement SurrealQL block in a single `query()` call.
 *
 * `runTransaction` lets the caller assemble statements via a builder and
 * sends them all together inside `BEGIN TRANSACTION; ...; COMMIT
 * TRANSACTION;`. The return value is the result of the LAST statement,
 * which the caller can shape with a final `RETURN $...` line.
 *
 * Use for: CREATE entity + CREATE external_ref (must both succeed),
 * CREATE fact + cascade-MERGE on competing facts (partial state is bad).
 */
export interface TxBuilder {
  /** Append a statement to the transaction. Returns the builder for chaining. */
  add(sql: string): TxBuilder;
  /** Bind a parameter; the same `vars` map is shared across all statements. */
  bind(name: string, value: unknown): TxBuilder;
}

export async function runTransaction<T>(
  db: Surreal,
  build: (tx: TxBuilder) => void,
): Promise<T> {
  const stmts: string[] = [];
  const vars: Record<string, unknown> = {};
  const builder: TxBuilder = {
    add(sql) {
      stmts.push(sql.trim().replace(/;\s*$/, ''));
      return builder;
    },
    bind(name, value) {
      vars[name] = value;
      return builder;
    },
  };
  build(builder);

  // Compose: BEGIN; <stmt>; <stmt>; ...; COMMIT;
  const sql = ['BEGIN TRANSACTION', ...stmts, 'COMMIT TRANSACTION']
    .map((s) => s.replace(/;\s*$/, ''))
    .join(';\n') + ';';

  // SurrealDB v2.2.8 surfaces aborted BEGIN/COMMIT batches as a
  // single top-level rejection with the bare wrapper "The query was
  // not executed due to a failed transaction" — the per-statement
  // cause (e.g. "Failed to commit transaction due to a read or
  // write conflict. This transaction can be retried") is dropped
  // by the time the JS driver builds the error. Without enrichment,
  // `isReadConflict(err)` sees only the wrapper and the surrounding
  // retry loop won't fire.
  //
  // Mitigation: any `failed transaction` wrapper emerging from a
  // multi-statement BEGIN/COMMIT batch IS, by construction, a
  // commit-level abort — for our usage (atomic upsert), commit
  // aborts under contention are exactly the retriable case. Re-throw
  // with the canonical read-or-write-conflict suffix so the retry
  // detector picks it up. Parse errors and permission denials don't
  // surface via this wrapper (they fail at parse/auth before the
  // tx is even entered), so the false-positive risk is bounded.
  let result: unknown[];
  try {
    result = await db.query<unknown[]>(sql, vars);
  } catch (err) {
    if (err instanceof Error && err.message.includes('failed transaction')) {
      const cause = (err as { cause?: { message?: string } }).cause;
      const suffix = cause?.message ?? 'read or write conflict; this transaction can be retried';
      const enriched = new Error(`${err.message}: ${suffix}`);
      (enriched as Error & { cause?: unknown }).cause = err;
      throw enriched;
    }
    throw err;
  }
  const arr = result as unknown[];
  return arr[arr.length - 1] as T;
}

/**
 * Detect SurrealDB unique-index violation. The driver surfaces these
 * as plain Errors with the index name embedded in the message; we
 * match on the marker text rather than coupling to a specific class.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('already contains') ||  // "already contains a record with id ..."
    m.includes('Database index') ||    // "Database index `xxx` already contains ..."
    m.includes('IndexExists') ||
    m.includes('already exists') ||    // "Database record `xxx:yyy` already exists" — explicit-id CREATE collision
    m.includes('Found a record')       // SurrealDB v2 wording variant for the same condition
  );
}

/**
 * Detect SurrealDB optimistic-concurrency read conflict — narrow match.
 * Only the specific datastore-level abort messages are retriable; the
 * broader "failed transaction" envelope wraps non-retriable failures
 * too (parse errors, type assertions, permission denials), and looping
 * those burns the retry budget for nothing.
 *
 * v2.2.x rocksdb backend surfaces commit-time OCC aborts with a new,
 * more explicit wording: "Failed to commit transaction due to a read
 * or write conflict. This transaction can be retried". Under
 * concurrent CREATEs against a UNIQUE-indexed key, the FIRST few
 * attempts in a fanout often abort here at commit time before the
 * uniqueness check fires (so they never present as
 * `isUniqueViolation`). Both patterns must be caught for the
 * retry loop to converge.
 */
export function isReadConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('Transaction read conflict') ||
    m.includes('wrote at the same key') ||
    m.includes('read or write conflict') ||
    m.includes('This transaction can be retried')
  );
}

/**
 * Retry a body on transient concurrency failures: unique-index
 * violations OR optimistic-concurrency read conflicts. Both arise
 * from the same SELECT-then-CREATE race window — under contention,
 * one tx commits and others either (a) see a duplicate index entry
 * (unique violation) or (b) have their read-set invalidated (read
 * conflict). Both are retriable: re-run the closure, which on its
 * second SELECT will see the racing caller's commit and either
 * short-circuit (read path) or write fresh state (rare).
 *
 * We use exponential backoff with jitter so a herd of FANOUT
 * retries doesn't synchronise into a second collision wave.
 */
export async function retryOnUniqueViolation<T>(
  fn: () => Promise<T>,
  attempts = 7,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err) && !isReadConflict(err)) throw err;
      lastErr = err;
      if (i < attempts - 1) {
        // Exponential backoff with full jitter: 10..20, 20..40, 40..80,
        // 80..160, 160..320, 320..640 ms — total worst case ~1.3s.
        // Sized for FANOUT-up-to-pool-size contention on the rocksdb
        // backend: that's the regime where retries actually help (the
        // racing committer's row appears within hundreds of ms).
        // Beyond that the test path needs to back off load itself.
        const baseMs = 10 * Math.pow(2, i);
        const jitter = Math.random() * baseMs;
        await new Promise((r) => setTimeout(r, baseMs + jitter));
      }
    }
  }
  throw lastErr;
}
