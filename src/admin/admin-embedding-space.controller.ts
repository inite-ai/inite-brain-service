import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePlatformTenant } from '../auth/tenant-scope';
import {
  EmbeddingSpaceService,
  type EmbeddingSpaceState,
} from '../ai/embedder/embedding-space.service';

/**
 * Admin surface for the zero-downtime embedding-space migration protocol
 * (multilingual Tier 2). Every mutating operation is gated at the service
 * layer (EMBEDDING_SPACE_DUAL_WRITE / EMBEDDING_SPACE_ACTIVE) AND scoped to
 * brain:admin, resolving the target tenant through the same platform-tenant
 * guard the HNSW maintenance surface uses. With the flags off these
 * endpoints refuse (400) rather than mutate — so the surface is inert by
 * default and cannot shift serving behaviour.
 *
 * ── READ THIS BEFORE RUNNING THE PROTOCOL ─────────────────────────────
 *
 * The state machine below is REAL and ATOMIC; what it drives is not yet
 * connected. `activeSpaceFor` / `targetSpaceFor`
 * (embedding-space.service.ts:88, :100) have no callers outside their own
 * class: no read path selects a space, no write path produces a
 * target-space vector, and no table has a second vector column for one to
 * land in. So with the flags ON an operator can run
 * begin → reindex → cutover to completion and change NOTHING about what is
 * served — the cutover flips a field nothing reads.
 *
 * That is deliberate scope, not an oversight (the service's own SCOPE NOTE
 * has said so since Tier 2), and the missing half is programme items E7-E9
 * of docs/roadmap/embedding-spaces-2026-09.md — a second vector column per
 * space, dual-write at every write site, and the resolver threaded through
 * the 13 cosine sites, the 4 KNN sites and the resolve_fact dedup gate.
 * Until those land, treat this surface as state-keeping only. The flags'
 * catalogue entries say the same thing, because the operator meets those
 * first.
 *
 * Recommended order once E7-E9 exist: begin → reindex
 * (POST /v1/admin/reindex/embeddings?allTables=true) → cutover. Arming
 * dual-write BEFORE the backfill is load-bearing, not stylistic: the other
 * order leaves the target space permanently missing every row written
 * during the backfill.
 */
@Controller('v1/admin/embedding-space')
@UseGuards(ApiKeyGuard)
export class AdminEmbeddingSpaceController {
  constructor(
    private readonly spaces: EmbeddingSpaceService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  private tenant(req: AuthenticatedRequest, requested?: string): string {
    return resolvePlatformTenant(req, requested, {
      knownTenants: () => this.apiKeys.knownCompanyIds(),
    });
  }

  /** Current per-tenant space state (active / target / phase). Read-only. */
  @Get('status')
  @RequireScopes('brain:admin')
  async status(
    @Req() req: AuthenticatedRequest,
    @Query('tenant') tenant?: string,
  ): Promise<EmbeddingSpaceState> {
    return this.spaces.getState(this.tenant(req, tenant));
  }

  /** Phase 1 — arm shadow dual-write into the target space. */
  @Post('begin')
  @RequireScopes('brain:admin')
  async begin(
    @Req() req: AuthenticatedRequest,
    @Body() body: { targetSpace?: string; tenant?: string } = {},
  ): Promise<EmbeddingSpaceState> {
    const target = body.targetSpace?.trim();
    if (!target) throw new BadRequestException('targetSpace is required');
    return this.spaces.beginMigration(this.tenant(req, body.tenant), target);
  }

  /** Phase 3 — atomic per-tenant cutover to the target space. */
  @Post('cutover')
  @RequireScopes('brain:admin')
  async cutover(
    @Req() req: AuthenticatedRequest,
    @Body() body: { targetSpace?: string; tenant?: string } = {},
  ): Promise<EmbeddingSpaceState> {
    const target = body.targetSpace?.trim();
    if (!target) throw new BadRequestException('targetSpace is required');
    return this.spaces.cutover(this.tenant(req, body.tenant), target);
  }

  /** Abort an in-flight migration (clears target + dual-write). */
  @Post('abort')
  @RequireScopes('brain:admin')
  async abort(
    @Req() req: AuthenticatedRequest,
    @Body() body: { tenant?: string } = {},
  ): Promise<EmbeddingSpaceState> {
    return this.spaces.abortMigration(this.tenant(req, body.tenant));
  }
}
