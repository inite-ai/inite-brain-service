import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { IndexerWorkService } from './indexer-work.service';
import { HeartbeatWorkDto } from './dto/heartbeat-work.dto';
import { FailWorkDto } from './dto/fail-work.dto';
import { assertDocumentIngestEnabled } from './documents-gate';

/**
 * Work discovery for EXTERNAL indexers (scope `indexer:write`): poll for
 * pending work → (optionally) claim → read stored content → extract
 * out-of-process → submit via POST /v1/documents/:id/candidates.
 * Protocol: docs/indexer-protocol.md. Dark behind DOCUMENT_INGEST_ENABLED
 * like the whole document pipeline.
 *
 * PII note: /content serves the document's verbatim stored text to an
 * `indexer:write` key — but only for documents ingest ROUTED to that
 * tenant's installed external packs, never arbitrary documents.
 */
@Controller('v1/indexer')
@UseGuards(ApiKeyGuard)
export class IndexerWorkController {
  constructor(private readonly work: IndexerWorkService) {}

  @Get('work')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.indexer.work')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('packId') packId?: string,
    @Query('limit') limit?: string,
  ) {
    assertDocumentIngestEnabled();
    return this.work.listWork({
      companyId: req.brainAuth.companyId,
      packId: packId || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('work/:runId/claim')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.indexer.claim')
  async claim(@Req() req: AuthenticatedRequest, @Param('runId') runId: string) {
    assertDocumentIngestEnabled();
    return this.work.claim({
      companyId: req.brainAuth.companyId,
      runId,
    });
  }

  @Post('work/:runId/heartbeat')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.indexer.heartbeat')
  async heartbeat(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
    @Body() body: HeartbeatWorkDto,
  ) {
    assertDocumentIngestEnabled();
    return this.work.heartbeat({
      companyId: req.brainAuth.companyId,
      runId,
      claimToken: body.claimToken,
    });
  }

  @Get('work/:runId/content')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.indexer.content')
  async content(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
  ) {
    assertDocumentIngestEnabled();
    return this.work.content({
      companyId: req.brainAuth.companyId,
      runId,
    });
  }

  @Post('work/:runId/fail')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.indexer.fail')
  async fail(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
    @Body() body: FailWorkDto,
  ) {
    assertDocumentIngestEnabled();
    return this.work.fail({
      companyId: req.brainAuth.companyId,
      runId,
      claimToken: body.claimToken,
      error: body.error,
      permanent: body.permanent,
    });
  }
}
