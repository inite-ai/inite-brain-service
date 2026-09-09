import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { join } from 'node:path';
import { SchemaMigrator } from './migrator.service';
import { enrichTransactionError } from './surreal-retry';
import { SESSION_REAUTH_MARGIN_MS, SurrealSessionKeeper } from './session-keeper';
import { envFlagEnabled } from '../common/env-validation';
import { getPolicyContext } from '../common/request-context';
import { compileDenyPushdown } from '../policy/db-fence';

// Re-export the error-classification + retry helpers from their dedicated
// module so existing `from './surreal.service'` import sites keep working.
export {
  isUniqueViolation,
  isReadConflict,
  enrichTransactionError,
  retryOnUniqueViolation,
} from './surreal-retry';

/**
 * How long the readiness probe waits for a scoped connection before it gives
 * the pool the benefit of the doubt. Short on purpose — see `pingScoped`.
 */
const SCOPED_PROBE_ACQUIRE_MS = 2000;
/** Bound on the per-acquire `RETURN 1` liveness probe (see ensureSession). */
const SESSION_PROBE_TIMEOUT_MS = 3000;

type PoolRole = 'root' | 'scoped';

/** Test-only construction options; production wiring passes none. */
export interface SurrealServiceOptions {
  /** Re-auth margin for both pools' session keepers (default 5 min). */
  sessionReauthMarginMs?: number;
}

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
 *
 * Two pools: root (admin paths — schema apply, GDPR forget, drop database,
 * compaction, ops scripts) and scoped (`brain_caller`, caller-facing reads).
 * The DB-level PERMISSIONS fence does NOT fire for `brain_caller` — a
 * namespace-level system user — so the application-layer row filter is the
 * effective PII/row barrier on both pools; the scoped pool is kept for the
 * Record Access track that will make PERMISSIONS apply (docs/abac.md).
 * Session lifetime, the re-auth discipline and the incident that shaped it:
 * docs/operations.md § Long-lived DB sessions and
 * docs/audits/runtime-auth-embedding-2026-09-08.md.
 */
@Injectable()
export class SurrealService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SurrealService.name);
  private readonly all: Surreal[] = [];
  private readonly rootIdle: Surreal[] = [];
  private readonly scopedIdle: Surreal[] = [];
  /**
   * Access-token expiry per pooled connection, one keeper per pool.
   * surrealdb-js invalidates a `signin()`-established session at `exp − 60s`
   * (it renews only sessions it opened itself), so every long-lived
   * connection must re-sign before that — see db/session-keeper.ts. Both
   * pools follow the same discipline in `ensureSession`.
   */
  private readonly sessionReauthMarginMs: number;
  private readonly rootSessions: SurrealSessionKeeper;
  private readonly scopedSessions: SurrealSessionKeeper;
  /** Every scoped-pool connection, idle or in flight (see resignScopedConns). */
  private readonly scopedAll = new Set<Surreal>();
  private scopedCreds?: { username: string; password: string; namespace: string };
  private readonly rootWaiters: Array<(c: Surreal) => void> = [];
  private readonly scopedWaiters: Array<(c: Surreal) => void> = [];
  private namespace!: string;
  private poolSize!: number;
  private scopedPoolSize!: number;
  private acquireTimeoutMs!: number;
  private scopedEnabled = false;
  // Track whether we've already overwritten brain_caller's password
  // this process boot for an existing-tenant case. Migrations only
  // re-run on fresh DBs; on re-deploys we still need to sync the
  // declared password with whatever SURREALDB_SCOPED_PASS now holds.
  // One-shot per process — cheap NS-level DDL but no need to repeat.
  private scopedPasswordSynced = false;
  private readonly knownDatabases = new Set<string>();
  /**
   * Called once per tenant database, immediately after its schema is
   * created/migrated — the single moment a tenant comes into existence in
   * this deployment (there is no onboarding route: `DEFINE DATABASE` in
   * ensureSchema is the only code that creates one, and it fires on the
   * first request that enters the tenant's scope).
   *
   * A callback rather than a dependency because this is the bottom of the
   * stack: SurrealService is constructed before, and injected into, every
   * service that could care. The contract is deliberately narrow — the
   * listener is SYNCHRONOUS and must not throw or block, because it runs
   * inside the global schema-apply queue on the first request for that
   * tenant. Anything real belongs on the listener's own timer.
   */
  private readonly schemaReadyListeners = new Set<(companyId: string) => void>();
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
  readonly migrator: SchemaMigrator;
  // Dedicated long-lived root connection used ONLY by the migrator,
  // NOT in either pool. Without this, ensureSchema acquires a root
  // conn from the pool — and under N-way fan-out where N == poolSize
  // and every caller targets the same fresh tenant, all pool conns
  // are held by callers awaiting ensureSchema, the migrator's own
  // acquireRoot() finds the pool empty, and the system deadlocks.
  // A standalone migrator conn breaks the cycle without changing
  // any caller-facing semantics.
  private migratorConn!: Surreal;
  /** Cached root credentials + URL so a connection can be fully rebuilt
   *  on failure: surrealdb-js (2.0.8) can hold a half-open socket that still
   *  reports connected (gh#618) or invalidate a signin()-established session
   *  on its own timer, and in both cases the only reliable repair is a fresh
   *  connection (`ensureSession`). History and measurements:
   *  docs/audits/runtime-auth-embedding-2026-09-08.md. */
  private rootCreds!: { username: string; password: string };
  private surrealUrl!: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() opts?: SurrealServiceOptions,
  ) {
    this.migrator = new SchemaMigrator(join(__dirname, 'migrations'));
    this.sessionReauthMarginMs = opts?.sessionReauthMarginMs ?? SESSION_REAUTH_MARGIN_MS;
    this.rootSessions = new SurrealSessionKeeper(this.sessionReauthMarginMs);
    this.scopedSessions = new SurrealSessionKeeper(this.sessionReauthMarginMs);
  }

  /**
   * Guarantee `conn` is connected and authenticated for `role` before it is
   * handed out. One discipline for both pools:
   *
   *   1. socket connected, session holds a token, token outside the re-auth
   *      margin → a `RETURN 1` probe (≈0.3 ms), which fails on a half-open
   *      socket (surrealdb-js gh#618: status stays "connected") and on an
   *      anonymous session alike;
   *   2. otherwise re-sign (≈16 ms, the server-side password KDF) — this is
   *      also what heals a session the driver already invalidated;
   *   3. if either fails, build a replacement connection FIRST and close the
   *      old one only once the replacement signed in, swapping the pool slot.
   *      If the replacement cannot sign in either, throw with the original
   *      still open — root callers propagate, `acquireScoped` fails closed.
   *
   * The root pool used to re-sign unconditionally on every acquire (which is
   * why writes never showed the expiry bug, at the KDF's cost on every
   * query); the scoped pool skipped the liveness probe. Returns the
   * connection to use — callers MUST use the returned reference.
   */
  private async ensureSession(conn: Surreal, role: PoolRole): Promise<Surreal> {
    const keeper = role === 'root' ? this.rootSessions : this.scopedSessions;
    try {
      if (conn.isConnected && conn.accessToken && !keeper.needsSignin(conn)) {
        await withTimeout(conn.query('RETURN 1'), SESSION_PROBE_TIMEOUT_MS, `${role} probe`);
      } else {
        await this.signin(conn, role);
      }
      return conn;
    } catch (e) {
      this.logger.warn(
        `${role} session check failed (${(e as Error).message?.slice(0, 120)}) — rebuilding conn`,
      );
    }
    const fresh = new Surreal();
    try {
      await withTimeout(fresh.connect(this.surrealUrl), 5000, 'connect');
      await this.signin(fresh, role);
    } catch (rebuildErr) {
      await withTimeout(fresh.close(), 1000, 'close').catch(() => undefined);
      throw rebuildErr;
    }
    keeper.forget(conn);
    await withTimeout(conn.close(), 1000, 'close').catch(() => undefined);
    // Swap the slot in `all` so process shutdown closes the replacement.
    const oldIdx = this.all.indexOf(conn);
    if (oldIdx >= 0) this.all[oldIdx] = fresh;
    else this.all.push(fresh);
    if (role === 'scoped') {
      this.scopedAll.delete(conn);
      this.scopedAll.add(fresh);
    }
    return fresh;
  }

  /** Sign `conn` in for `role` and record the access token's expiry. */
  private async signin(conn: Surreal, role: PoolRole): Promise<void> {
    const creds = role === 'root' ? this.rootCreds : this.scopedCreds;
    if (!creds) throw new Error(`${role} credentials not configured`);
    const tokens = await withTimeout(conn.signin(creds), 3000, `${role} signin`);
    (role === 'root' ? this.rootSessions : this.scopedSessions).record(conn, tokens?.access);
  }

  async onModuleInit() {
    const url = this.configService.getOrThrow<string>('SURREALDB_URL');
    const username = this.configService.getOrThrow<string>('SURREALDB_USERNAME');
    const password = this.configService.getOrThrow<string>('SURREALDB_PASSWORD');
    this.namespace = this.configService.get<string>('SURREALDB_NAMESPACE', 'brain');
    this.poolSize = parseInt(this.configService.get<string>('SURREALDB_POOL_SIZE', '8'), 10);
    this.scopedPoolSize = parseInt(
      this.configService.get<string>('SURREALDB_SCOPED_POOL_SIZE', '8'),
      10,
    );
    this.acquireTimeoutMs = parseInt(
      this.configService.get<string>('SURREALDB_ACQUIRE_TIMEOUT_MS', '10000'),
      10,
    );
    if (!Number.isFinite(this.poolSize) || this.poolSize < 1) {
      throw new Error('SURREALDB_POOL_SIZE must be a positive integer');
    }
    if (!Number.isFinite(this.acquireTimeoutMs) || this.acquireTimeoutMs < 100) {
      throw new Error('SURREALDB_ACQUIRE_TIMEOUT_MS must be >= 100ms');
    }

    // Cache for re-signin / rebuild on ws drops (see ensureSession).
    this.rootCreds = { username, password };
    this.surrealUrl = url;

    // Dedicated migrator connection — root-signed, NOT in any pool.
    // ensureSchema runs against this conn so callers holding pool conns
    // in withCompany/withScopedCompany never block on migration acquiring
    // a fresh root conn from a saturated pool.
    this.migratorConn = new Surreal();
    await this.migratorConn.connect(url);
    await this.signin(this.migratorConn, 'root');
    this.all.push(this.migratorConn);

    // Root pool — admin signin.
    for (let i = 0; i < this.poolSize; i++) {
      const conn = new Surreal();
      await conn.connect(url);
      await this.signin(conn, 'root');
      this.all.push(conn);
      this.rootIdle.push(conn);
    }

    // Scoped pool — sign in as `brain_caller` (defined in migration 0005).
    // Disabled cleanly when the user/password aren't set: reads then run on
    // the root pool (same effective app-layer barrier — see the class note).
    const scopedUser = this.configService.get<string>('SURREALDB_SCOPED_USER');
    const scopedPass = this.configService.get<string>('SURREALDB_SCOPED_PASS');
    if (scopedUser && scopedPass) {
      this.scopedEnabled = true;
      this.scopedCreds = {
        username: scopedUser,
        password: scopedPass,
        namespace: this.namespace,
      };
      for (let i = 0; i < this.scopedPoolSize; i++) {
        const conn = new Surreal();
        await conn.connect(url);
        try {
          await this.signin(conn, 'scoped');
        } catch (e) {
          // First boot: `brain_caller` does not exist until migration 0005
          // lands (the tenant-registry refresh runs it right after boot).
          // Leave the connection unauthenticated — the keeper holds no
          // record for it, so the next acquire re-signs, and fails closed
          // if that still does not work. It is never signed in as root.
          this.logger.warn(
            `Scoped signin failed (${(e as Error).message}) — ` +
              `the connection will re-sign on its first acquire`,
          );
        }
        this.all.push(conn);
        this.scopedAll.add(conn);
        this.scopedIdle.push(conn);
      }
    }

    this.logger.log(
      `Connected to SurrealDB at ${url}, root_pool=${this.poolSize}, ` +
        `scoped_pool=${this.scopedEnabled ? this.scopedPoolSize : 'off'}, ` +
        `namespace=${this.namespace}`,
    );
  }

  // Close the pool in onApplicationShutdown (the LAST lifecycle phase), not
  // onModuleDestroy (the FIRST). Consumers that release DB-backed state on
  // shutdown — the worker loop's lease release (beforeApplicationShutdown),
  // any onModuleDestroy DB touch — must find the pool still open. Closing here
  // guarantees the pool outlives every earlier-phase shutdown hook.
  async onApplicationShutdown() {
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
      await withTimeout(this.all[0]!.version(), 3000, 'version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Readiness probe for the CALLER-FACING read path: takes a scoped
   * connection and runs the same authorization-gated check a request runs
   * (`ensureSession`). `ping()` cannot see an anonymous session — `version()`
   * is answered for one too — which is how /ready stayed green through the
   * 2026-09-08 outage.
   *
   * A BUSY pool is deliberately NOT a readiness failure: saturation is
   * already visible as acquire-timeout 5xx, and answering "not ready" for
   * it would pull pods out of rotation when the rest are most loaded. The
   * question here is "can the read path authorize", not "is it idle".
   * Returns true when the scoped pool is disabled (`ping()` covers root).
   */
  async pingScoped(): Promise<boolean> {
    if (!this.scopedEnabled) return true;
    // Time only the queue, not authentication. An available slot whose
    // signin takes >2s is an auth probe in progress, not a saturated pool.
    const acquiring = this.acquireWithTimeout(this.scopedIdle, this.scopedWaiters, 'scoped');
    let conn: Surreal | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      conn = await Promise.race([
        acquiring,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SCOPED_PROBE_ACQUIRE_MS);
        }),
      ]);
    } catch {
      // Pool acquisition itself failed.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!conn) {
      // Still queued. Hand the connection straight back whenever it lands,
      // so an abandoned probe never leaks a pool slot.
      void acquiring.then((c) => this.releaseScoped(c)).catch(() => undefined);
      return true;
    }
    try {
      // ensureSession already ran the authorization-gated probe (or a fresh
      // signin) on this connection — that IS the readiness check.
      conn = await this.ensureSession(conn, 'scoped');
      return true;
    } catch {
      return false;
    } finally {
      this.releaseScoped(conn);
    }
  }

  /**
   * Run a callback inside a per-tenant database scope on a pool-acquired
   * ROOT connection. Schema is applied lazily on first use of a database.
   * The connection is exclusive to this callback for its lifetime.
   *
   * Use this for admin paths: schema apply, GDPR forget, drop database,
   * compaction, ops scripts. Caller-facing paths use `withScopedCompany`
   * (the application-layer filter is the effective PII/row barrier — the
   * DB-level PERMISSIONS fence does NOT fire for the system `brain_caller`
   * user today; see withScopedCompany and docs/abac.md).
   */
  async withCompany<T>(companyId: string, fn: (db: Surreal) => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const database = `co_${companyId}`;
    let conn = await this.acquireRoot();
    try {
      // ensureSession may hand back a rebuilt connection — always use the
      // returned reference.
      conn = await this.ensureSession(conn, 'root');
      await conn.use({ namespace: this.namespace, database });
      await this.ensureSchema(conn, database);
      return await fn(conn);
    } finally {
      this.releaseRoot(conn);
    }
  }

  /**
   * Run a callback inside the system database — the home for global,
   * tenant-agnostic state: `leader_lease` (cron leader election),
   * `job_run` rows for cross-tenant jobs, future operator-action
   * audit-of-audit etc.
   *
   * Same root pool + ensureSchema as withCompany, but with the fixed
   * database name `system` (no `co_` prefix) so it's clearly distinct
   * from tenant data. Migrations 0028+ that DEFINE these tables apply
   * to every database including this one — the tenant-side copies sit
   * unused, the system-side copy is the active one. Cheap, idempotent,
   * avoids a parallel migrator just for two tables.
   */
  async withAdminDb<T>(fn: (db: Surreal) => Promise<T>): Promise<T> {
    const database = 'system';
    let conn = await this.acquireRoot();
    try {
      conn = await this.ensureSession(conn, 'root');
      await conn.use({ namespace: this.namespace, database });
      await this.ensureSchema(conn, database);
      return await fn(conn);
    } finally {
      this.releaseRoot(conn);
    }
  }

  /**
   * Run a callback inside a per-tenant DB scope on a SCOPED connection
   * (`brain_caller`, EDITOR role, not root).
   *
   * R4 audit — do not claim a barrier that does not exist: SurrealDB skips
   * table/field PERMISSIONS for system users, and `LET` session variables
   * do not persist across query() calls, so the DB-level fence is INERT on
   * this connection. The effective PII/row barrier is the application-layer
   * filter (policy/row-filter.ts, entity-read.helpers). The scoped identity
   * and the `$caller_scopes` / `$caller_policy_deny` binding are kept so a
   * real fence can be switched on with Record Access; the 0057 canary
   * (test/abac-db-fence.e2e-spec.ts) fails loudly if PERMISSIONS ever start
   * firing. See docs/abac.md § DB-level fence status.
   *
   * With the scoped pool disabled this runs on the root pool — identical
   * effective enforcement.
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
    // ABAC DB fence (migration 0057, flag default off): compile the
    // request's pushdown-safe deny rules off the AsyncLocalStorage policy
    // context and bind them for the knowledge_fact field PERMISSIONS. NOTE
    // (R4 audit): this fence is INERT today (PERMISSIONS are skipped for the
    // system brain_caller user — see the withScopedCompany docstring); the
    // app-layer row filter is the effective gate. The binding is kept armed
    // for the future Record Access track.
    const policyDeny = envFlagEnabled(process.env.ABAC_DB_FENCE_ENABLED)
      ? compileDenyPushdown(getPolicyContext())
      : [];
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
      // Bind scopes + policy-deny for this request. The variables live
      // until the next LET on this connection — releasing back to the
      // pool doesn't reset them, but the next withScopedCompany call
      // overwrites BOTH before the user-fn runs, so cross-request
      // contamination is impossible ($caller_policy_deny is always
      // re-bound, [] when the fence is off or no rules push down).
      await conn.query(`LET $caller_scopes = $scopes; LET $caller_policy_deny = $policyDeny`, {
        scopes: [...scopes],
        policyDeny,
      });
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
    let conn = await this.acquireRoot();
    try {
      conn = await this.ensureSession(conn, 'root');
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
    return this.acquireWithTimeout(this.rootIdle, this.rootWaiters, 'root');
  }

  private releaseRoot(conn: Surreal): void {
    const next = this.rootWaiters.shift();
    if (next) {
      next(conn);
    } else {
      this.rootIdle.push(conn);
    }
  }

  private async acquireScoped(): Promise<Surreal> {
    const conn = await this.acquireWithTimeout(this.scopedIdle, this.scopedWaiters, 'scoped');
    try {
      return await this.ensureSession(conn, 'scoped');
    } catch (e) {
      // Fail CLOSED. A deployment that configured the scoped pool asked for
      // the narrower identity; serving the request root-authorized would
      // widen privilege exactly when the caller believes it narrowed. The
      // (still open) connection goes back for the next acquire's retry; a
      // 503 tells balancers and retrying clients this is availability, not
      // a bug.
      this.releaseScoped(conn);
      throw new ServiceUnavailableException(
        `scoped DB signin unavailable — failing closed rather than ` +
          `serving the request root-authorized: ${(e as Error).message}`,
      );
    }
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
   * Pool acquire with a hard timeout. Before this guard a waiter
   * could sit FOREVER if every connection leaked (any code path that
   * acquired but never released). Now the request fails fast with a
   * 503-equivalent — operator sees the symptom in /admin/now (slow
   * requests) and /admin/throttler (5xx rate) instead of a silent
   * hang.
   *
   * Default 10s — chosen to be longer than any legitimate query, but
   * short enough that a single stuck request doesn't drag the rest
   * of the tenant. Configurable via SURREALDB_ACQUIRE_TIMEOUT_MS.
   */
  private acquireWithTimeout(
    idle: Surreal[],
    waiters: Array<(c: Surreal) => void>,
    label: 'root' | 'scoped',
  ): Promise<Surreal> {
    const free = idle.shift();
    if (free) return Promise.resolve(free);
    return new Promise<Surreal>((resolve, reject) => {
      const ms = this.acquireTimeoutMs;
      const enqueued: (c: Surreal) => void = (c) => {
        clearTimeout(t);
        resolve(c);
      };
      const t = setTimeout(() => {
        const i = waiters.indexOf(enqueued);
        if (i >= 0) waiters.splice(i, 1);
        reject(
          new Error(
            `Surreal ${label} pool acquire timed out after ${ms}ms (pool=${this.poolSize}, waiters=${waiters.length}). Likely a connection leak — check long-running requests in /admin/now.`,
          ),
        );
      }, ms);
      waiters.push(enqueued);
    });
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
      // finish. ensureSession may return a rebuilt conn — track
      // the swap so future migrations use the live reference.
      this.migratorConn = await this.ensureSession(this.migratorConn, 'root');
      // SurrealDB 3.x no longer auto-creates a namespace/database on first
      // DEFINE — `use()` + DDL against a non-existent NS/DB errors ("The
      // namespace 'brain' does not exist"). 2.x created them implicitly.
      // Provision both explicitly, idempotently, at root before selecting
      // the tenant DB. DEFINE NAMESPACE is a root op (no NS selected);
      // DEFINE DATABASE needs the NS selected. Identifiers can't be
      // parameterized, so we backtick-quote — companyId is already
      // validated `^[a-zA-Z0-9_-]+$` in withCompany, and `database` is
      // `co_<companyId>` / `system`.
      await this.migratorConn.query(`DEFINE NAMESPACE IF NOT EXISTS \`${this.namespace}\``);
      await this.migratorConn.use({ namespace: this.namespace });
      await this.migratorConn.query(`DEFINE DATABASE IF NOT EXISTS \`${database}\``);
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
      this.notifySchemaReady(database);
    });
    this.schemaQueue = next.catch(() => undefined);
    await next;
  }

  /**
   * Register a tenant-schema-ready listener. Listeners are SYNCHRONOUS and
   * must not throw or block: they run inside the global schema-apply queue
   * on the first request for that tenant, so anything real belongs on the
   * listener's own timer. Several may register (a Set, not a slot) — the
   * contract is the same for one listener as for five.
   */
  onTenantSchemaReady(listener: (companyId: string) => void): void {
    this.schemaReadyListeners.add(listener);
  }

  /**
   * Fire the listener for a TENANT database only — `system` is the
   * platform's own DB and has no companyId. Never throws: a listener fault
   * must not fail the request that happened to be first through the door,
   * and must not poison the schema queue for every other tenant behind it.
   */
  private notifySchemaReady(database: string): void {
    if (this.schemaReadyListeners.size === 0 || !database.startsWith('co_')) return;
    const companyId = database.slice('co_'.length);
    for (const listener of this.schemaReadyListeners) {
      try {
        listener(companyId);
      } catch (e) {
        this.logger.warn(`tenant schema-ready listener threw: ${(e as Error).message}`);
      }
    }
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
    // SurrealDB 3.x requires DEFINE USER … PASSWORD to be a string LITERAL
    // (a "strand"), not a bound parameter — `PASSWORD $pass` raises
    // "Unexpected token `a parameter`, expected a strand". Splice the secret
    // as an escaped single-quoted literal. scopedPass is an operator-supplied
    // env secret; escape backslashes then single quotes so it can't break out
    // of the literal or malform the DDL.
    const escapedPass = scopedPass.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    try {
      await this.migratorConn.query(
        `DEFINE USER OVERWRITE ${scopedUser} ON NAMESPACE PASSWORD '${escapedPass}' ` +
          `ROLES EDITOR${this.scopedTokenDurationClause()}`,
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
   * Optional `DURATION FOR TOKEN …` clause for the scoped user, from
   * SURREALDB_SCOPED_TOKEN_DURATION. Empty by default, which leaves
   * SurrealDB's own default (1h) in place.
   *
   * This exists because brain OVERWRITEs `brain_caller` on every boot, so
   * a duration an operator sets by hand is silently discarded on the next
   * deploy — the knob makes the token lifetime brain's declared property
   * rather than an invisible server default. It is NOT the fix for session
   * expiry (a longer token only moves the cliff; the pool re-signs before
   * either lapses — see ensureSession), but it makes the lifetime
   * explicit and lets the expiry path be tested in seconds instead of an
   * hour.
   *
   * Durations cannot be bound as parameters, so the value is spliced —
   * hence the strict shape check. Anything else is refused, loudly.
   */
  private scopedTokenDurationClause(): string {
    const decision = scopedTokenDurationDecision(
      this.configService.get<string>('SURREALDB_SCOPED_TOKEN_DURATION'),
      this.sessionReauthMarginMs,
    );
    if (decision.problem) this.logger.error(decision.problem);
    return decision.clause;
  }

  /**
   * Re-sign the idle scoped connections after migration 0005 lands or the
   * scoped password was rotated. In-flight connections re-sign on their
   * next acquire (the keeper record is dropped here so they must).
   */
  private async resignScopedConns(): Promise<void> {
    if (!this.scopedCreds) return;
    for (const conn of this.scopedAll) {
      if (!this.scopedIdle.includes(conn)) {
        this.scopedSessions.forget(conn);
        continue;
      }
      try {
        await this.signin(conn, 'scoped');
      } catch (e) {
        this.scopedSessions.forget(conn);
        this.logger.warn(`Re-signin to scoped failed for an idle conn: ${(e as Error).message}`);
      }
    }
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
  // A CREATE that returns no row means the write didn't land. Returning
  // arr[0] would hand back `undefined` typed as T and corrupt every caller
  // downstream — fail loud instead.
  if (arr.length === 0) {
    throw new Error(`dbCreate(${table}) returned no row`);
  }
  return arr[0]!; // length > 0 guaranteed by the guard above
}

export async function dbMerge<T extends Record<string, unknown>>(
  db: Surreal,
  recordId: string,
  patch: Record<string, unknown>,
): Promise<T> {
  const [rows] = await db.query<[T[]]>(`UPDATE type::record($t, $i) MERGE $p RETURN AFTER`, {
    t: tableOf(recordId),
    i: idOf(recordId),
    p: patch,
  });
  const arr = (rows as T[]) ?? [];
  // An UPDATE...MERGE that matched no record returns []. Returning arr[0]
  // would hand back `undefined` typed as T — surface the missing record.
  if (arr.length === 0) {
    throw new Error(`dbMerge(${recordId}) matched no record`);
  }
  return arr[0]!; // length > 0 guaranteed by the guard above
}

/**
 * Run a single-statement SELECT/UPDATE/DELETE and return its row array,
 * typed as `T[]`. `db.query<[T[]]>()` types the one result slot; the
 * `?? []` guards the (impossible-in-practice, but typed-as-optional) empty
 * response so callers always get an array to map/filter over.
 *
 * This is the typed replacement for the `(await db.query(sql)) as any` /
 * `(rows as any[]) ?? []` idiom that used to litter the store services.
 * Pass a row interface reflecting the columns the SELECT actually returns:
 *
 *   interface CountRow { c: number }
 *   const [{ c }] = await queryRows<CountRow>(db, 'SELECT count() AS c ...');
 *
 * For multi-statement batches (LET/RETURN, several SELECTs), call
 * `db.query<[A[], B[]]>()` directly and index the tuple — this helper is
 * for the common single-statement case.
 */
export async function queryRows<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T[]> {
  const [rows] = await db.query<[T[]]>(sql, vars);
  return (rows as T[]) ?? [];
}

/**
 * Run a single-statement query and return only its first row (or
 * `undefined` when the query matched nothing). Typed convenience over
 * `queryRows` for the `LIMIT 1` / by-id lookup shape.
 */
export async function queryFirst<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T | undefined> {
  const rows = await queryRows<T>(db, sql, vars);
  return rows[0];
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

export async function runTransaction<T>(db: Surreal, build: (tx: TxBuilder) => void): Promise<T> {
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
  const sql =
    ['BEGIN TRANSACTION', ...stmts, 'COMMIT TRANSACTION']
      .map((s) => s.replace(/;\s*$/, ''))
      .join(';\n') + ';';

  // Aborted BEGIN/COMMIT batches surface as a bare "failed transaction"
  // wrapper that hides the retriable per-statement cause; enrich it so the
  // surrounding retry loop can classify it (see enrichTransactionError).
  // Non-wrapper errors pass through unchanged.
  let result: unknown[];
  try {
    result = await db.query<unknown[]>(sql, vars);
  } catch (err) {
    throw enrichTransactionError(err);
  }
  const arr = result as unknown[];
  // The caller's last statement is the RETURN it wants, but WHERE that
  // lands in the response depends on the server generation (verified
  // empirically against v2.3.10 and v3.1.5):
  //
  //   3.x — one slot per top-level statement INCLUDING `BEGIN` and the
  //   trailing `COMMIT` (both null): N user statements → N+2 slots, the
  //   RETURN sits at length-2. Taking length-1 here reads the COMMIT
  //   null and silently turns every transactional upsert into
  //   `undefined` (historically: spurious self-merge 400s).
  //
  //   2.x — BEGIN/COMMIT emit no slots (and LETs may be collapsed too):
  //   always ≤ N slots, the RETURN is simply the LAST one. Taking
  //   length-2 there reads the statement BEFORE the RETURN — on prod
  //   v2.3.10 this made every lease acquire and job claim silently
  //   discard its committed result (gauge stuck at 0, queue never
  //   dispatched) with zero errors logged.
  //
  // We compose exactly one BEGIN and one COMMIT, so the shapes are
  // disjoint: only a 3.x server can answer with stmts+2 slots.
  return (arr.length === stmts.length + 2 ? arr[arr.length - 2] : arr[arr.length - 1]) as T;
}

/**
 * The decision behind SURREALDB_SCOPED_TOKEN_DURATION, as a pure function so
 * it can be pinned: an unparseable literal is IGNORED (the server default,
 * 1h, stays) and reported; a literal at or under the session re-auth margin
 * is HONOURED — a token that lives shorter than the margin is always "about
 * to expire", so every scoped acquire pays the ~16 ms signin KDF, which only
 * the expiry e2e wants — and reported. `problem` is the operator-facing line.
 */
export function scopedTokenDurationDecision(
  raw: string | undefined,
  reauthMarginMs: number,
): { clause: string; problem?: string } {
  const value = raw?.trim();
  if (!value) return { clause: '' };
  const ms = surrealDurationToMs(value);
  if (ms === undefined) {
    return {
      clause: '',
      problem: `Ignoring SURREALDB_SCOPED_TOKEN_DURATION='${value}' — not a SurrealDB duration literal`,
    };
  }
  const clause = ` DURATION FOR TOKEN ${value}`;
  if (ms <= reauthMarginMs) {
    return {
      clause,
      problem:
        `SURREALDB_SCOPED_TOKEN_DURATION='${value}' is within the ${reauthMarginMs}ms ` +
        `session re-auth margin: every scoped acquire will re-sign. Intended for tests only.`,
    };
  }
  return { clause };
}

/**
 * A SurrealDB duration literal (`5s`, `1h`, `30m`…) in milliseconds, or
 * undefined when the string is not one. Sub-millisecond units round down.
 */
export function surrealDurationToMs(raw: string): number | undefined {
  const m = /^(\d+)(ns|us|ms|s|m|h|d|w|y)$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };
  return Math.floor(n * unit[m[2]!]!);
}

/**
 * Race a promise against a timer; reject if the timer wins. Used to guard
 * surrealdb-js calls against zombie-websocket hangs (gh#618) where the
 * underlying socket is half-open and queries / signin never get a
 * response. Without this, ensureSession could wedge a request for
 * minutes before the OS reaps the TCP connection.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SurrealDB ${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
