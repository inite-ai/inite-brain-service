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

/** companyId identifier shape, matching SurrealService.withCompany's guard. */
const COMPANY_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * How often the in-memory active-roster cache is refreshed from the
 * system-DB `tenant_registry` table. 60s is far below any fan-out cron
 * cadence, so a tenant that authenticates is visible to the next sweep
 * well within one interval — and register()/touch() update the cache
 * synchronously anyway, so the timer is only a backstop for rows written
 * by OTHER pods.
 */
const REFRESH_MS = 60_000;

/**
 * Per-tenant throttle on the lastSeen DB write from touch(). touch() runs
 * on the hot auth path (every authenticated request); the cache add is
 * synchronous and unconditional, but the DB round-trip is coalesced to at
 * most once per tenant per window so a busy tenant does not hammer the
 * system DB just to bump a timestamp.
 */
const TOUCH_THROTTLE_MS = 5 * 60_000;

/**
 * TenantRegistryService — the production tenant roster (R4 finding #1).
 *
 * ApiKeyService.knownCompanyIds() (the enumeration every background fan-out
 * and the platform-operator cross-tenant scope go through) historically
 * read companyIds off the in-memory BRAIN_API_KEYS table. In production
 * with a remote verifier (JWKS / introspection) that static table is
 * disabled and typically empty, so the roster was [] and every fan-out
 * silently did nothing. This service backs the roster with a real DB table
 * (`tenant_registry`, migration 0104) living in the SYSTEM database — the
 * one place every tenant can be enumerated from regardless of credential
 * source — and keeps a synchronously-readable in-memory cache so
 * knownCompanyIds() stays synchronous and no fan-out caller has to change.
 *
 * Fallback: the cache reflects only what the registry contains. When the
 * registry is empty or unavailable, ApiKeyService.knownCompanyIds() unions
 * this (empty) set with the static BRAIN_API_KEYS set and returns the
 * latter unchanged — byte-identical to pre-0104 dev / single-tenant /
 * bootstrap behaviour. In prod the registry fills at runtime as tenants
 * authenticate (touch() from CredentialResolverService) or are provisioned
 * (register()).
 *
 * Optional SurrealService: unit-test fixtures construct this with no
 * connection; every method degrades to a pure in-memory no-op then.
 */
@Injectable()
export class TenantRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantRegistryService.name);
  /** Active companyIds as last read from / written to the registry. */
  private readonly activeCache = new Set<string>();
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
    // if the DB write is briefly delayed; a non-active status drops it.
    if (status === 'active') this.activeCache.add(companyId);
    else this.activeCache.delete(companyId);
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
   * Hot-path "this tenant just authenticated" hook. Synchronously adds the
   * tenant to the active cache (so the very first authenticated request in a
   * prod-JWKS deployment makes the tenant visible to fan-out immediately),
   * then fires a throttled, non-blocking lastSeen upsert. Never throws — a
   * registry write must not fail an authenticated request.
   *
   * A brand-new row is created with the field DEFAULT status 'active'; an
   * existing row keeps its status (a suspended tenant is not silently
   * reactivated — the next refresh() drops it back out of the cache).
   */
  touch(companyId: string): void {
    if (!COMPANY_ID.test(companyId)) return;
    this.activeCache.add(companyId);
    if (!this.surreal) return;
    const now = Date.now();
    const last = this.lastWriteAt.get(companyId);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
    this.lastWriteAt.set(companyId, now);
    // Fire-and-forget: the request path does not wait on the registry.
    void this.surreal
      .withAdminDb(async (db) => {
        await db.query(
          `UPSERT type::record('tenant_registry', $companyId) SET
             companyId = $companyId,
             lastSeen = time::now(),
             updatedAt = time::now()`,
          { companyId },
        );
      })
      .catch((e) => this.logger.warn(`touch(${companyId}) write failed: ${(e as Error).message}`));
  }

  /** Replace the cache with the current active roster; keep old on failure. */
  private async refresh(): Promise<void> {
    try {
      const active = await this.readActive();
      this.activeCache.clear();
      for (const id of active) this.activeCache.add(id);
    } catch (e) {
      // Transient DB error — keep the last-known-good cache rather than
      // wiping the roster (which would starve fan-out).
      this.logger.warn(`registry refresh failed, keeping cached roster: ${(e as Error).message}`);
    }
  }

  private async readActive(): Promise<string[]> {
    if (!this.surreal) return [];
    return this.surreal.withAdminDb(async (db) => {
      const rows = await queryRows<TenantRow>(
        db,
        `SELECT companyId FROM tenant_registry WHERE status = 'active'`,
      );
      return [...new Set(rows.map((r) => r.companyId).filter((id): id is string => Boolean(id)))];
    });
  }
}
