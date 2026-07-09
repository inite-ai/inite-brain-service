import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { DocumentStoreService } from './document-store.service';
import { CandidateStoreService } from './candidate-store.service';
import { assertDocumentIngestEnabled } from './documents-gate';

/**
 * Read + erasure surface of the document pipeline: the document header,
 * its indexer runs, the Candidates-layer audit view, and the explicit
 * content purge. Writes live in DocumentsIngestController. Dark behind
 * DOCUMENT_INGEST_ENABLED (default off).
 */
@Controller('v1/documents')
@UseGuards(ApiKeyGuard)
export class DocumentsController {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
  ) {}

  @Get(':id')
  @RequireScopes('brain:read')
  async getDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('includeText') includeText?: string,
  ) {
    assertDocumentIngestEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const runs = await this.candidates.listRuns(req.brainAuth.companyId, id);
    const chunks =
      includeText === '1'
        ? await this.store.getChunks(req.brainAuth.companyId, id)
        : undefined;
    return { ...doc, runs, ...(chunks ? { chunks } : {}) };
  }

  @Get(':id/candidates')
  @RequireScopes('brain:read')
  async listCandidates(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    assertDocumentIngestEnabled();
    const doc = await this.store.getById(req.brainAuth.companyId, id);
    if (!doc) throw new NotFoundException('document not found');
    const candidates = await this.candidates.listByDoc(
      req.brainAuth.companyId,
      id,
    );
    return { documentId: doc.id, candidates };
  }

  @Delete(':id/content')
  @RequireScopes('brain:admin')
  async purge(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    assertDocumentIngestEnabled();
    const purged = await this.store.purgeContent(req.brainAuth.companyId, id);
    if (!purged) throw new NotFoundException('document not found');
    return { purged: true };
  }
}
