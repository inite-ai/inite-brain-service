import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { envFlagEnabled } from '../common/env-validation';
import { DocumentIngestService } from './document-ingest.service';
import { DocumentAsyncService } from './document-async.service';
import { DocumentReindexService } from './document-reindex.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';
import { assertDocumentIngestEnabled, docMaxChars } from './documents-gate';

/**
 * Write surface of the document pipeline. Dark behind
 * DOCUMENT_INGEST_ENABLED (default off) — flag off answers 503 and the
 * legacy mention/fact paths stay byte-identical.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class DocumentsIngestController {
  constructor(
    private readonly ingest: DocumentIngestService,
    private readonly async: DocumentAsyncService,
    private readonly reindex: DocumentReindexService,
  ) {}

  @Post('ingest/document')
  @RequireScopes('brain:write')
  @PolicyAction('ingest_document')
  // Document ingest runs the LLM extractor per chunk; cap per-credential.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async ingestDocument(@Req() req: AuthenticatedRequest, @Body() body: IngestDocumentDto) {
    assertDocumentIngestEnabled();
    this.validate(body);
    if (body.mode === 'async') {
      return this.async.ingestAsync(req.brainAuth.companyId, body);
    }
    return this.ingest.ingestDocument(req.brainAuth.companyId, body);
  }

  @Post('documents/:id/commit')
  @RequireScopes('brain:admin')
  @PolicyAction('rest.documents.commit')
  async commit(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    assertDocumentIngestEnabled();
    const result = await this.ingest.commitPending(req.brainAuth.companyId, id);
    if (!result) throw new NotFoundException('document not found');
    return result;
  }

  /** Backfill: run one pack's extraction over the tenant's stored docs. */
  @Post('admin/documents/reindex')
  @RequireScopes('brain:admin')
  async reindexDocuments(@Req() req: AuthenticatedRequest, @Body() body: { packId?: string }) {
    assertDocumentIngestEnabled();
    if (!body?.packId || typeof body.packId !== 'string') {
      throw new BadRequestException('packId is required');
    }
    const result = await this.reindex.enqueueForPack(req.brainAuth.companyId, body.packId);
    if (!result) {
      throw new NotFoundException(`pack "${body.packId}" is not installed for this tenant`);
    }
    return result;
  }

  private validate(body: IngestDocumentDto): void {
    if (!body?.contextRef?.vertical || typeof body.contextRef.vertical !== 'string') {
      throw new BadRequestException('contextRef.vertical is required');
    }
    if (typeof body.text === 'string' && body.text.length > docMaxChars()) {
      throw new BadRequestException(`text exceeds DOC_MAX_CHARS (${docMaxChars()})`);
    }
    if (
      body.indexers !== undefined &&
      body.indexers !== 'auto' &&
      body.indexers !== 'general' &&
      (!Array.isArray(body.indexers) || body.indexers.some((s) => typeof s !== 'string' || !s))
    ) {
      throw new BadRequestException(`indexers must be 'general', 'auto', or an array of pack ids`);
    }
    if (body.mode === 'async') {
      if (!envFlagEnabled(process.env.DOCUMENT_MULTI_INDEXER_ENABLED)) {
        throw new BadRequestException('mode=async requires DOCUMENT_MULTI_INDEXER_ENABLED');
      }
      if (body.storeContent === false) {
        // Queue jobs re-read chunks from the DB; nothing stored = nothing
        // to index.
        throw new BadRequestException('mode=async requires storeContent');
      }
    }
  }
}
