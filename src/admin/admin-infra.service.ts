import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { resolvePlatformTenantScope } from '../auth/tenant-scope';
import type { MigrationsResponse } from '../contracts/admin/migrations.schema';

/**
 * DB-touching logic for the infra cockpit, lifted out of
 * AdminInfraController so the controller stays HTTP plumbing and does not
 * import from src/db (layer-purity gate — import/no-restricted-paths).
 * Holds the connection ping and the per-tenant migration audit.
 */
@Injectable()
export class AdminInfraService {
  private readonly logger = new Logger(AdminInfraService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  /** Connection liveness ping; false on any error (never throws). */
  async pingDb(): Promise<boolean> {
    try {
      return await this.surreal.ping();
    } catch {
      return false;
    }
  }

  /**
   * Per-tenant migration audit: every migration in the manifest + which
   * tenants applied each, with drift detection (a tenant missing a
   * migration the others have). Reads each tenant's ledger as it IS —
   * `readMigrationLedger` does not migrate first, unlike `withCompany`, so
   * a tenant behind the manifest shows its pending files and a failing
   * tenant shows them too instead of being re-migrated by the audit. A
   * tenant whose ledger cannot be read is reported with `error` (and
   * nothing applied or pending claimed) rather than failing the audit; the
   * error text is generic — the cause is in the server log.
   */
  async migrationsAudit(req: AuthenticatedRequest): Promise<MigrationsResponse> {
    const manifest = await this.surreal.migrator.loadManifest();
    // Tenant isolation: a plain brain:admin audits only its own tenant's
    // schema state (and never enumerates the tenant roster); a platform
    // operator (scope + gate) keeps the cross-tenant drift audit.
    const tenants = resolvePlatformTenantScope(req, undefined, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
      fanOutTenants: () => this.apiKeys.fanOutRoster(),
    });
    const perTenant: MigrationsResponse['perTenant'] = [];
    for (const companyId of tenants) {
      try {
        const applied = await this.surreal.readMigrationLedger(companyId);
        const appliedSet = new Set(applied);
        const pending = manifest.filter((m) => !appliedSet.has(m.id)).map((m) => m.id);
        perTenant.push({ companyId, applied, pending });
      } catch (e) {
        this.logger.warn(`Migration ledger read failed for a tenant: ${(e as Error).message}`);
        perTenant.push({ companyId, applied: [], pending: [], error: 'ledger read failed' });
      }
    }
    const driftDetected = perTenant.some((t) => t.pending.length > 0 || t.error !== undefined);
    return {
      manifest: manifest.map((m) => ({ id: m.id, name: m.name })),
      perTenant,
      driftDetected,
    } satisfies MigrationsResponse;
  }
}
