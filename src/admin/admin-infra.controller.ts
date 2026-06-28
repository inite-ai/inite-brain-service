import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AdminInfraService } from './admin-infra.service';
import { HealthComponentsService } from './health-components.service';
import { LiveSnapshotService } from './live-snapshot.service';
import type { HealthComponentsResponse } from '../contracts/admin/health-components.schema';
import type { MigrationsResponse } from '../contracts/admin/migrations.schema';
import type { ThrottlerResponse } from '../contracts/admin/throttler.schema';
import type { NowResponse } from '../contracts/admin/now.schema';

/**
 * Infra cockpit — deeper than /health. Per-component status grid,
 * migrations applied per tenant + drift detection, throttler
 * observability, in-flight HTTP requests.
 *
 *   /v1/admin/health/components — per-component grid for the sidebar
 *   /v1/admin/migrations        — applied vs pending per tenant
 *   /v1/admin/throttler         — top routes / actors / recent 429s
 *   /v1/admin/now               — currently in-flight HTTP requests
 *
 * HTTP plumbing only — the per-component probing lives in
 * HealthComponentsService, the live snapshots in LiveSnapshotService,
 * and the DB/migration reads in AdminInfraService.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminInfraController {
  constructor(
    private readonly adminInfra: AdminInfraService,
    private readonly healthComponents: HealthComponentsService,
    private readonly liveSnapshot: LiveSnapshotService,
  ) {}

  /**
   * Per-component health grid. Each component reports status (ok |
   * warming | degraded | disabled | unreachable) + latency (when
   * cheap) + a short message. Distinct from /health which is the
   * binary up/down for k8s.
   */
  @Get('health/components')
  @RequireScopes('brain:admin')
  async healthComponentsView(): Promise<HealthComponentsResponse> {
    const dbStart = Date.now();
    const dbOk = await this.adminInfra.pingDb();
    return this.healthComponents.build(dbOk, Date.now() - dbStart);
  }

  /**
   * Per-tenant migration audit. Lists every migration in the manifest
   * + which tenants have applied each one. Highlights drift (tenants
   * missing migrations the others have).
   */
  @Get('migrations')
  @RequireScopes('brain:admin')
  async migrations(): Promise<MigrationsResponse> {
    return this.adminInfra.migrationsAudit();
  }

  @Get('throttler')
  @RequireScopes('brain:admin')
  throttlerView(): ThrottlerResponse {
    return this.liveSnapshot.throttlerSnapshot();
  }

  @Get('now')
  @RequireScopes('brain:admin')
  now(): NowResponse {
    return this.liveSnapshot.now();
  }
}
