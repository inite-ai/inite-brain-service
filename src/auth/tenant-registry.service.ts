import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { SurrealService, queryRows, retryOnUniqueViolation } from '../db/surreal.service';

/** Metadata attached when a tenant is (re)registered / provisioned. */
export interface TenantRegistryMeta {
  status?: 'active' | 'suspended' | 'provisioning';
  schemaVersion?: string;
  embeddingSpace?: string;
  indexState?: string;
}

interface TenantRow {
  companyId: string;
}

/** What the provisioning path observed about one tenant's vector indexes. */
export interface TenantIndexState {
  /** Fold over every HNSW index: ready | building | partial | absent | mismatch | unknown. */
  state: string;
  /** `name=state` per index, so 'partial' names which half is missing. */
  detail?: string;
  /** The embedding space the indexes were built for (`provider:model:dim:norm`). */
  embeddingSpace?: string;
}

/** One roster row as the operator reads it — no DDL, no per-tenant probe. */
export interface TenantIndexStateRow extends TenantIndexState {
  companyId: string;
  status: string;
  /** When `state` was observed. Absent = never observed. */
  observedAt?: string;
}

/** companyId identifier shape, matching SurrealService.withCompany's guard. */
const COMPANY_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * How often the in-memory roster cache is refreshed from the system-DB
 * `tenant_registry` table. 60s is far below any fan-out cron cadence, so
 * a tenant that authenticates is visible to the next sweep well within
 * one interval — and register()/touch() reconcile the cache as they learn
 * a tenant's status anyway, so the timer is only a backstop for rows
 * written by OTHER pods (a suspension issued elsewhere lands here within
 * one interval).
 */
const REFRESH_MS = 60_000;

/**
 * Per-tenant throttle on the lastSeen DB write from touch(). touch() runs
 * on the hot auth path (every authenticated request); the roster cache is
 * reconciled synchronously from the status this pod already knows, but the
 * DB round-trip is coalesced to at most once per tenant per window so a
 * busy tenant does not hammer the system DB just to bump a timestamp.
 */
const TOUCH_THROTTLE_MS = 5 * 60_000;

type TenantStatus = NonNullable<TenantRegistryMeta['status']>;

/** A roster row as the registry reads it back — companyId plus lifecycle status. */
interface RosterRow extends TenantRow {
  status?: string;
}

/**
 * TenantRegistryService — the production tenant roster (R4 finding #1).
 *
 * Tenant enumeration historically read companyIds off the in-memory
 * BRAIN_API_KEYS table. In production with a remote verifier (JWKS /
 * introspection) that static table is disabled and typically empty, so the
 * roster was [] and every fan-out silently did nothing. This service backs
 * the roster with a real DB table (`tenant_registry`, migration 0104)
 * living in the SYSTEM database — the one place every tenant can be
 * enumerated from regardless of credential source — and keeps a
 * synchronously-readable in-memory cache so the ApiKeyService accessors
 * stay synchronous. Two of them read it: fanOutRoster() (background loops;
 * registry-active ONLY, static keys just as the empty-registry fallback)
 * and knownCompanyIds() (operator `?tenant=` validation; the union).
 *
 * Fallback: the cache reflects only what the registry contains. When the
 * registry is empty or unavailable, both accessors return the static
 * BRAIN_API_KEYS set — the pre-0104 dev / single-tenant / bootstrap
 * behaviour. In prod the registry fills at runtime as tenants authenticate
 * (touch() from CredentialResolverService) or are provisioned (register()).
 *
 * Optional SurrealService: unit-test fixtures construct this with no
 * connection; every method degrades to a pure in-memory no-op then.
 */
@Injectable()
export class TenantRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantRegistryService.name);
  /** Active companyIds as last read from / written to the registry. */
  private readonly activeCache = new Set<string>();
  /**
   * companyId -> lifecycle status as this pod last learned it (a refresh
   * read, a register() write, or the status a touch() write echoed back).
   * Membership in `activeCache` is derived from THIS, never from activity:
   * a suspended tenant that keeps authenticating with a still-valid
   * credential must not re-enter the fan-out roster, not even for the
   * window until the next refresh (audit 2026-09-06, F9).
   */
  private readonly knownStatus = new Map<string, TenantStatus>();
  /** companyId -> last epoch-ms we wrote lastSeen (touch throttle). */
  private readonly lastWriteAt = new Map<string, number>();
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(@Optional() private readonly surreal?: SurrealService) {}

  onModuleInit(): void {
    if (!this.surreal) return; // dev / unit tests — nothing to refresh
    // Best-effort initial load. Not awaited: module init must not block on
    // the DB (and SurrealService may still be connecting). Failures keep
    // the cache empty, which is exactly the BRAIN_API_KEYS-fallback state.
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
    // Do not keep the event loop (or a jest worker) alive for the timer.
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /**
   * The active tenant roster as currently cached — synchronous, for
   * knownCompanyIds(). Empty until the registry has been read or a
   * register()/touch() has landed a tenant.
   */
  activeCompanyIds(): string[] {
    return [...this.activeCache];
  }

  /**
   * Read the active roster straight from the registry (system DB). Returns
   * [] when no connection is wired or on a read error — callers treat an
   * empty read as "fall back to the static set", never as an authoritative
   * "no tenants". Use activeCompanyIds() for the hot synchronous path.
   */
  async listActive(): Promise<string[]> {
    try {
      return await this.readActive();
    } catch (e) {
      this.logger.warn(`listActive read failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Provisioning / offboarding upsert: write the tenant's full registry row
   * (status + optional schema/embedding metadata) and reconcile the cache.
   * Awaitable — provisioning callers want the write to land.
   */
  async register(companyId: string, meta: TenantRegistryMeta = {}): Promise<void> {
    if (!COMPANY_ID.test(companyId)) {
      throw new Error(`Invalid companyId: ${companyId}`);
    }
    const status = meta.status ?? 'active';
    // Reconcile the cache first so the tenant is visible immediately even
    // if the DB write is briefly delayed; a non-active status drops it —
    // and is remembered, so a later touch() cannot lift it.
    this.noteStatus(companyId, status);
    if (!this.surreal) return;
    // Only SET the optional metadata that was actually supplied: the fields
    // are option<string>, and SurrealDB rejects a bound NULL on an option
    // type ("Expected `none | string` but found `NULL`"). Omitting an absent
    // field also PRESERVES a prior value on a status-only re-register instead
    // of wiping it. Field names are code-controlled literals, never input.
    const sets = [
      'companyId = $companyId',
      'status = $status',
      'lastSeen = time::now()',
      'updatedAt = time::now()',
    ];
    const vars: Record<string, unknown> = { companyId, status };
    if (meta.schemaVersion !== undefined) {
      sets.push('schemaVersion = $schemaVersion');
      vars.schemaVersion = meta.schemaVersion;
    }
    if (meta.embeddingSpace !== undefined) {
      sets.push('embeddingSpace = $embeddingSpace');
      vars.embeddingSpace = meta.embeddingSpace;
    }
    if (meta.indexState !== undefined) {
      sets.push('indexState = $indexState');
      vars.indexState = meta.indexState;
    }
    await retryOnUniqueViolation(() =>
      this.surreal!.withAdminDb(async (db) => {
        await db.query(
          `UPSERT type::record('tenant_registry', $companyId) SET ${sets.join(', ')}`,
          vars,
        );
      }),
    );
    this.lastWriteAt.set(companyId, Date.now());
  }

  /**
   * Hot-path "this tenant just authenticated" hook: records that the tenant
   * was seen (a throttled, non-blocking lastSeen upsert) and reconciles the
   * roster cache from the tenant's lifecycle STATUS — never from the
   * activity itself. Never throws — a registry write must not fail an
   * authenticated request.
   *
   * Activity and membership are separate on purpose. A suspended tenant's
   * credentials may still be valid (suspension is a registry state, not a
   * key revocation), so it keeps arriving here; it used to be re-added to
   * the fan-out roster on every request, until the next refresh() dropped
   * it again — a suspended tenant in and out of background sweeps by the
   * minute. Now:
   *   - a tenant this pod knows to be active is visible synchronously, as
   *     before (the very first request in a prod-JWKS deployment makes it
   *     visible to fan-out at once);
   *   - a tenant this pod knows to be suspended/provisioning stays out;
   *   - an UNKNOWN tenant is added only after the write echoes the row's
   *     status back — a brand-new row is created with the field DEFAULT
   *     'active', an existing row keeps whatever status it has. The few
   *     milliseconds of the round-trip are the price of never lifting a
   *     suspension, even transiently.
   */
  touch(companyId: string): void {
    if (!COMPANY_ID.test(companyId)) return;
    const known = this.knownStatus.get(companyId);
    if (!this.surreal) {
      // In-memory mode (dev / unit fixtures): register() is the only thing
      // that can suspend, and it is remembered; anything else is active.
      if (known === undefined) this.noteStatus(companyId, 'active');
      return;
    }
    if (known === 'active') this.activeCache.add(companyId);
    const now = Date.now();
    const last = this.lastWriteAt.get(companyId);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
    this.lastWriteAt.set(companyId, now);
    // Fire-and-forget: the request path does not wait on the registry.
    void this.surreal
      .withAdminDb(async (db) => {
        const [rows] = await db.query<[Array<{ status?: string }>]>(
          `UPSERT type::record('tenant_registry', $companyId) SET
             companyId = $companyId,
             lastSeen = time::now(),
             updatedAt = time::now()
           RETURN status`,
          { companyId },
        );
        const status = (rows as Array<{ status?: string }> | undefined)?.[0]?.status;
        // No echoed status (an older server shape, a stub) → the tenant is
        // not admitted on this pod until a refresh reads its row: fail
        // closed on membership, the write still recorded the activity.
        if (status !== undefined) this.noteStatus(companyId, status);
      })
      .catch((e) => this.logger.warn(`touch(${companyId}) write failed: ${(e as Error).message}`));
  }

  /**
   * The one place membership is decided: remember the status, and derive
   * the active roster from it. Anything that is not 'active' (suspended,
   * provisioning, or an unexpected value) is out.
   */
  private noteStatus(companyId: string, status: string): void {
    const known: TenantStatus =
      status === 'active' || status === 'suspended' || status === 'provisioning'
        ? status
        : 'suspended';
    this.knownStatus.set(companyId, known);
    if (known === 'active') this.activeCache.add(companyId);
    else this.activeCache.delete(companyId);
  }

  /**
   * Record what the provisioning path observed about a tenant's vector
   * indexes (0104's reserved `indexState`/`embeddingSpace`, plus 0133's
   * `indexStateAt`/`indexDetail`). This is the only write that makes
   * "which tenants have a ready HNSW index" answerable from ONE row set
   * instead of a DDL-adjacent probe against every tenant database.
   *
   * Deliberately NOT register(): that method writes `status`, defaulting
   * it to 'active', so recording an observation through it would silently
   * reactivate a suspended tenant and re-add it to the fan-out roster.
   * This one touches the index columns and nothing else — and, unlike
   * touch(), does not bump `lastSeen`, because a maintenance sweep looking
   * at a tenant is not that tenant being seen.
   *
   * Never throws: the caller is a background sweep, and a registry write
   * failing must cost it that tenant's bookkeeping, not the run.
   */
  async recordIndexState(companyId: string, observed: TenantIndexState): Promise<void> {
    if (!COMPANY_ID.test(companyId) || !this.surreal) return;
    // Only SET what was supplied — the columns are option<> and SurrealDB
    // rejects a bound NULL on an option type. Names are code literals.
    const sets = ['companyId = $companyId', 'indexState = $indexState'];
    const vars: Record<string, unknown> = {
      companyId,
      indexState: observed.state,
      at: new Date().toISOString(),
    };
    if (observed.detail !== undefined) {
      sets.push('indexDetail = $indexDetail');
      vars.indexDetail = observed.detail;
    }
    if (observed.embeddingSpace !== undefined) {
      sets.push('embeddingSpace = $embeddingSpace');
      vars.embeddingSpace = observed.embeddingSpace;
    }
    try {
      await retryOnUniqueViolation(() =>
        this.surreal!.withAdminDb(async (db) => {
          await db.query(
            // Point UPSERT by record id — never UPDATE … WHERE over an
            // indexed field (3.2.4's planner silently matches zero rows).
            // `indexStateAt` is bound as an ISO string and cast, the
            // leader_lease idiom: the 2-arg datetime forms differ across
            // SurrealDB majors.
            `UPSERT type::record('tenant_registry', $companyId) SET ${sets.join(', ')},
               indexStateAt = type::datetime($at), updatedAt = time::now()`,
            vars,
          );
        }),
      );
    } catch (e) {
      this.logger.warn(`recordIndexState(${companyId}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * The whole roster with its recorded index state — the read that answers
   * "which tenants have a ready index" without opening a single tenant
   * database. Suspended tenants are included on purpose: an operator
   * chasing a gap needs to see that a tenant is out of the roster, not have
   * it vanish. Returns [] when no connection is wired or the read fails.
   */
  async listIndexState(): Promise<TenantIndexStateRow[]> {
    if (!this.surreal) return [];
    try {
      return await this.surreal.withAdminDb(async (db) => {
        const rows = await queryRows<{
          companyId?: string;
          status?: string;
          indexState?: string;
          indexDetail?: string;
          indexStateAt?: string | Date;
          embeddingSpace?: string;
        }>(
          db,
          `SELECT companyId, status, indexState, indexDetail, indexStateAt, embeddingSpace
             FROM tenant_registry ORDER BY companyId`,
        );
        return rows
          .filter((r): r is typeof r & { companyId: string } => Boolean(r.companyId))
          .map((r) => ({
            companyId: r.companyId,
            status: r.status ?? 'active',
            // 'unknown' rather than a guess: no observation has been
            // recorded, which is exactly the state this change exists to
            // make visible instead of assumed.
            state: r.indexState ?? 'unknown',
            ...(r.indexDetail !== undefined ? { detail: r.indexDetail } : {}),
            ...(r.embeddingSpace !== undefined ? { embeddingSpace: r.embeddingSpace } : {}),
            ...(r.indexStateAt !== undefined
              ? { observedAt: new Date(r.indexStateAt).toISOString() }
              : {}),
          }));
      });
    } catch (e) {
      this.logger.warn(`listIndexState read failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Replace the cache with the current roster; keep old on failure. Reads
   * EVERY row, not only the active ones: a suspension written by another
   * pod has to be learned here, or a touch() on this pod would keep the
   * tenant's status unknown and its lastSeen writes would decide.
   */
  private async refresh(): Promise<void> {
    try {
      const roster = await this.readRoster();
      this.activeCache.clear();
      this.knownStatus.clear();
      for (const row of roster) this.noteStatus(row.companyId, row.status);
    } catch (e) {
      // Transient DB error — keep the last-known-good cache rather than
      // wiping the roster (which would starve fan-out).
      this.logger.warn(`registry refresh failed, keeping cached roster: ${(e as Error).message}`);
    }
  }

  private async readActive(): Promise<string[]> {
    return (await this.readRoster()).filter((r) => r.status === 'active').map((r) => r.companyId);
  }

  /** Every registry row with its status, deduped by companyId. */
  private async readRoster(): Promise<Array<{ companyId: string; status: string }>> {
    if (!this.surreal) return [];
    return this.surreal.withAdminDb(async (db) => {
      const rows = await queryRows<RosterRow>(db, `SELECT companyId, status FROM tenant_registry`);
      const byId = new Map<string, string>();
      for (const r of rows) {
        if (!r.companyId) continue;
        // The column is SCHEMAFULL with DEFAULT 'active'; a missing value
        // can only come from a stub, and reads as the default it would have.
        byId.set(r.companyId, r.status ?? 'active');
      }
      return [...byId].map(([companyId, status]) => ({ companyId, status }));
    });
  }
}
