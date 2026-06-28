import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import type { MigrationsResponse } from '../contracts/admin/migrations.schema';

/**
 * DB-touching logic for the infra cockpit, lifted out of
 * AdminInfraController so the controller stays HTTP plumbing and does not
 * import from src/db (layer-purity gate — import/no-restricted-paths).
 * Holds the connection ping and the per-tenant migration audit.
 */
@Injectable()
export class AdminInfraService {
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
   * migration the others have). A tenant whose schema_migrations read
   * throws is reported as fully pending rather than failing the audit.
   */
  async migrationsAudit(): Promise<MigrationsResponse> {
    const manifest = await this.surreal.migrator.loadManifest();
    const tenants = this.apiKeys.knownCompanyIds();
    const perTenant: Array<{
      companyId: string;
      applied: string[];
      pending: string[];
    }> = [];
    for (const companyId of tenants) {
      try {
        const applied = await this.surreal.withCompany(companyId, async (db) => {
          const res = (await db.query<any[]>(
            `SELECT migrationId FROM schema_migrations`,
          )) as any[];
          const rows = (res[0] ?? []) as Array<{ migrationId: string }>;
          return rows.map((r) => r.migrationId).sort();
        });
        const appliedSet = new Set(applied);
        const pending = manifest
          .filter((m) => !appliedSet.has(m.id))
          .map((m) => m.id);
        perTenant.push({ companyId, applied, pending });
      } catch (e) {
        perTenant.push({
          companyId,
          applied: [],
          pending: manifest.map((m) => m.id),
        });
        void e;
      }
    }
    const driftDetected = perTenant.some((t) => t.pending.length > 0);
    return {
      manifest: manifest.map((m) => ({ id: m.id, name: m.name })),
      perTenant,
      driftDetected,
    } satisfies MigrationsResponse;
  }
}
