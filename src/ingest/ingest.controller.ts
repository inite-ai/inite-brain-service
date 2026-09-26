import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { IngestService } from './ingest.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('v1/ingest')
@UseGuards(ApiKeyGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('fact')
  @RequireScopes('brain:write')
  @PolicyAction('record_fact')
  async ingestFact(@Req() req: AuthenticatedRequest, @Body() body: IngestFactDto) {
    return this.ingest.ingestFact(req.brainAuth.companyId, body);
  }

  @Post('mention')
  @RequireScopes('brain:write')
  @PolicyAction('rest.ingest.mention')
  // Mention ingest runs the LLM extractor; cap per-credential rate.
  @Throttle({ expensive: { limit: 10, ttl: 60_000 } })
  async ingestMention(@Req() req: AuthenticatedRequest, @Body() body: IngestMentionDto) {
    // Direct or through the document pipeline: IngestService decides
    // (INGEST_MENTION_VIA_DOCUMENT), for every caller alike.
    return this.ingest.ingestMention(req.brainAuth.companyId, body);
  }

  @Post('link')
  @RequireScopes('brain:write')
  @PolicyAction('link_entities')
  async ingestLink(@Req() req: AuthenticatedRequest, @Body() body: IngestLinkDto) {
    return this.ingest.ingestLink(req.brainAuth.companyId, body);
  }
}
