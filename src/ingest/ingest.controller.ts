import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { envFlagEnabled } from '../common/env-validation';
import { MentionViaDocumentService } from '../documents/mention-via-document.service';
import { IngestService } from './ingest.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/ingest')
@UseGuards(ApiKeyGuard)
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly mentionViaDocument: MentionViaDocumentService,
  ) {}

  @Post('fact')
  @RequireScopes('brain:write')
  async ingestFact(
    @Req() req: AuthenticatedRequest,
    @Body() body: IngestFactDto,
  ) {
    return this.ingest.ingestFact(req.brainAuth.companyId, body);
  }

  @Post('mention')
  @RequireScopes('brain:write')
  // Mention ingest runs the LLM extractor; cap per-credential rate.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async ingestMention(
    @Req() req: AuthenticatedRequest,
    @Body() body: IngestMentionDto,
  ) {
    // INGEST_MENTION_VIA_DOCUMENT (default off): route the mention through
    // the document pipeline — same response contract, one decision engine.
    // Flag off = the legacy path, untouched.
    if (envFlagEnabled(process.env.INGEST_MENTION_VIA_DOCUMENT)) {
      return this.mentionViaDocument.ingest(req.brainAuth.companyId, body);
    }
    return this.ingest.ingestMention(req.brainAuth.companyId, body);
  }

  @Post('link')
  @RequireScopes('brain:write')
  async ingestLink(
    @Req() req: AuthenticatedRequest,
    @Body() body: IngestLinkDto,
  ) {
    return this.ingest.ingestLink(req.brainAuth.companyId, body);
  }
}
