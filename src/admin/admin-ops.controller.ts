import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { AdminService } from './admin.service';
import { ConfigInspectorService } from './config-inspector.service';
import { OperatorActionService } from './operator-action.service';
import type { DlqResponse } from '../contracts/admin/dlq.schema';
import type { ForgottenResponse } from '../contracts/admin/forgotten.schema';
import type { OperatorActionsResponse } from '../contracts/admin/operator-actions.schema';
import type { PiiInventoryResponse } from '../contracts/admin/pii.schema';

/**
 * Operator power-tools / GDPR surface.
 *
 *   /v1/admin/config            — env knob catalogue (read-only)
 *   /v1/admin/dlq               — full dead-letter list + delete
 *   /v1/admin/forgotten         — forgotten entities list + GDPR export
 *   /v1/admin/pii               — PII inventory per (tenant, predicate)
 *   /v1/admin/operator-actions  — HTTP audit log of admin calls
 *
 * The split keeps each operator workflow scoped. Sensitive scopes
 * are enforced on the route (PII inventory requires brain:read_pii).
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminOpsController {
  constructor(
    private readonly admin: AdminService,
    private readonly config: ConfigInspectorService,
    private readonly actions: OperatorActionService,
  ) {}

  // ── Config viewer ────────────────────────────────────────

  @Get('config')
  @RequireScopes('brain:admin')
  configList() {
    return { entries: this.config.list() };
  }

  // ── Dead-letter ───────────────────────────────────────────

  @Get('dlq')
  @RequireScopes('brain:admin')
  async dlq(
    @Query('companyId') companyId?: string,
    @Query('reason') reason?: string,
    @Query('limit') limit?: string,
  ): Promise<DlqResponse> {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return {
      rows: await this.admin.listDeadLetter({
        companyId: companyId?.trim() || undefined,
        reason: reason?.trim() || undefined,
        limit:
          parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      }),
    } satisfies DlqResponse;
  }

  @Delete('dlq/:companyId/:id')
  @RequireScopes('brain:admin')
  async dlqDelete(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const deleted = await this.admin.deleteDeadLetter(companyId, id);
    return { deleted };
  }

  // ── Forgotten ─────────────────────────────────────────────

  @Get('forgotten')
  @RequireScopes('brain:admin')
  async forgotten(
    @Query('companyId') companyId?: string,
    @Query('reason') reason?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<ForgottenResponse> {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return {
      rows: await this.admin.listForgotten({
        companyId: companyId?.trim() || undefined,
        reason: reason?.trim() || undefined,
        since: since?.trim() || undefined,
        limit:
          parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      }),
    } satisfies ForgottenResponse;
  }

  /**
   * GDPR proof-of-erasure export. Returns a JSON manifest of every
   * forgotten_entity row matching the filter — operator hands this to
   * a Data Protection Officer when responding to a DSAR.
   *
   * Note: payload contains only entityIdHash + counts + reason + ts.
   * The actual entity data is gone; that's the whole point.
   */
  @Get('forgotten/export')
  @RequireScopes('brain:admin')
  async forgottenExport(
    @Res() res: Response,
    @Query('companyId') companyId?: string,
    @Query('since') since?: string,
  ) {
    const rows = await this.admin.listForgotten({
      companyId: companyId?.trim() || undefined,
      since: since?.trim() || undefined,
      limit: 2000,
    });
    const manifest = {
      generatedAt: new Date().toISOString(),
      filter: {
        companyId: companyId?.trim() || null,
        since: since?.trim() || null,
      },
      total: rows.length,
      certificateNotice:
        'This manifest enumerates entities erased from the brain service. The original payloads have been deleted; only the hashed identifier, deletion reason, and counts of removed facts/edges remain. Issued in accordance with GDPR Art. 17 ("right to erasure") proof-of-deletion obligations.',
      entries: rows,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="forgotten-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.send(JSON.stringify(manifest, null, 2));
  }

  // ── PII inventory ──────────────────────────────────────────
  //
  // We require brain:read_pii on top of brain:admin — surfacing the
  // catalogue of sensitive predicates is itself a sensitive view.

  @Get('pii')
  @RequireScopes('brain:admin', 'brain:read_pii')
  async piiInventory(): Promise<PiiInventoryResponse> {
    return {
      rows: await this.admin.listPiiInventory(),
    } satisfies PiiInventoryResponse;
  }

  // ── Operator action log ───────────────────────────────────

  @Get('operator-actions')
  @RequireScopes('brain:admin')
  async operatorActions(
    @Req() req: AuthenticatedRequest,
    @Query('actor') actor?: string,
    @Query('pathPrefix') pathPrefix?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<OperatorActionsResponse> {
    void req; // reserved for future per-key scoping
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return {
      rows: await this.actions.list({
        actor: actor?.trim() || undefined,
        pathPrefix: pathPrefix?.trim() || undefined,
        since: since?.trim() || undefined,
        limit:
          parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      }),
    } satisfies OperatorActionsResponse;
  }
}
