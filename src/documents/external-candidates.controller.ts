import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ExternalCandidatesService } from './external-candidates.service';
import { DocumentIngestService } from './document-ingest.service';
import { SubmitCandidatesDto } from './dto/submit-candidates.dto';
import { assertDocumentIngestEnabled } from './documents-gate';

/**
 * The external-indexer write surface: a remote service that read a
 * stored document stages its CandidateBatch here. Requires the narrow
 * `indexer:write` scope — such a key can propose hypotheses but never
 * write facts directly. After staging, the Brain commits when every run
 * for the document is settled (same deferral rule as the async queue).
 */
@Controller('v1/documents')
@UseGuards(ApiKeyGuard)
export class ExternalCandidatesController {
  constructor(
    private readonly external: ExternalCandidatesService,
    private readonly ingest: DocumentIngestService,
  ) {}

  @Post(':id/candidates')
  @RequireScopes('indexer:write')
  @PolicyAction('rest.documents.stage_candidates')
  // Staging is DB-only, but each submission fans into entity resolution +
  // fact resolves at commit — keep the same per-credential ceiling as
  // document ingest.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async submit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SubmitCandidatesDto,
  ) {
    assertDocumentIngestEnabled();
    const companyId = req.brainAuth.companyId;
    const submission = await this.external.submit({
      companyId,
      docId: id,
      dto: body,
    });
    const commit = await this.ingest.commitIfSettled(companyId, id);
    return {
      ...submission,
      commit: commit
        ? {
            deferred: commit.deferred,
            committed: commit.committed,
            counts: commit.counts,
          }
        : null,
    };
  }
}
