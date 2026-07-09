import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { envFlagEnabled } from '../common/env-validation';
import { DocumentIngestService } from './document-ingest.service';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';

/**
 * The document ingest surface (Source → Indexer → Candidates → Brain).
 * Dark behind DOCUMENT_INGEST_ENABLED (default off) — with the flag off
 * every route answers 503 feature_disabled and the legacy mention/fact
 * paths stay byte-identical.
 */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class DocumentsController {
  constructor(
    private readonly ingest: DocumentIngestService,
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
  ) {}

  @Post('ingest/document')
  @RequireScopes('brain:write')
  // Document ingest runs the LLM extractor per chunk; cap per-credential.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async ingestDocument(
    @Req() req: AuthenticatedRequest,
    @Body() body: IngestDocumentDto,
  ) {
    this.assertEnabled();
    if (!body?.contextRef?.vertical || typeof body.contextRef.vertical !== 'string') {
      throw new BadRequestException('contextRef.vertical is required');
    }
    if (body.mode === 'async') {
      // Wave 2 (DOCUMENT_MULTI_INDEXER_ENABLED) brings the queue.
      throw new BadRequestException(
        'mode=async requires multi-indexer support; use sync for now',
      );
    }
    if (tooLarge(body.text)) {
      throw new BadRequestException(
        `text exceeds DOC_MAX_CHARS (${docMaxChars()})`,
      );
    }
    return this.ingest.ingestDocument(req.brainAuth.companyId, body);
  }

  @Get('documents/:id')
  @RequireScopes('brain:read')
  async getDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('includeText') includeText?: string,
  ) {
    this.assertEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const chunks =
      includeText === '1'
        ? await this.store.getChunks(req.brainAuth.companyId, id)
        : undefined;
    return { ...doc, ...(chunks ? { chunks } : {}) };
  }

  @Get('documents/:id/candidates')
  @RequireScopes('brain:read')
  async listCandidates(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    this.assertEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const candidates = await this.candidates.listByDoc(
      req.brainAuth.companyId,
      id,
    );
    return { documentId: doc.id, candidates };
  }

  @Post('documents/:id/commit')
  @RequireScopes('brain:admin')
  async commit(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    this.assertEnabled();
    const result = await this.ingest.commitPending(req.brainAuth.companyId, id);
    if (!result) throw new NotFoundException('document not found');
    return result;
  }

  @Delete('documents/:id/content')
  @RequireScopes('brain:admin')
  async purge(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    this.assertEnabled();
    const purged = await this.store.purgeContent(req.brainAuth.companyId, id);
    if (!purged) throw new NotFoundException('document not found');
    return { purged: true };
  }

  private assertEnabled(): void {
    if (!envFlagEnabled(process.env.DOCUMENT_INGEST_ENABLED)) {
      throw new ServiceUnavailableException({
        error: 'feature_disabled',
        message: 'Document ingest is disabled (DOCUMENT_INGEST_ENABLED)',
      });
    }
  }
}

function docMaxChars(): number {
  const v = process.env.DOC_MAX_CHARS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 512_000;
}

function tooLarge(text: unknown): boolean {
  return typeof text === 'string' && text.length > docMaxChars();
}
