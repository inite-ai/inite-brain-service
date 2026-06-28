import { Injectable } from '@nestjs/common';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { IngestResult } from './ingest-result';
import { FactIngestService } from './fact-ingest.service';
import { MentionIngestService } from './mention-ingest.service';
import { LinkIngestService } from './link-ingest.service';

// Re-exported for callers that import the result types from this module.
export type { IngestOutcome, IngestResult } from './ingest-result';

/**
 * Thin facade over the three ingest paths, each its own focused service:
 *  - {@link FactIngestService}    — typed direct ingest (`ingestFact`)
 *  - {@link MentionIngestService} — free-text → LLM extraction (`ingestMention`)
 *  - {@link LinkIngestService}    — edge / identity declaration (`ingestLink`)
 *
 * The shared per-fact write primitive lives in `FactResolverService`
 * (embed + policy + fn::resolve_fact + HyPE), entity resolution in
 * `EntityUpsertService`. This class only routes; it holds no logic of its own.
 */
@Injectable()
export class IngestService {
  constructor(
    private readonly factIngest: FactIngestService,
    private readonly mentionIngest: MentionIngestService,
    private readonly linkIngest: LinkIngestService,
  ) {}

  ingestFact(companyId: string, dto: IngestFactDto): Promise<IngestResult> {
    return this.factIngest.ingestFact(companyId, dto);
  }

  ingestMention(companyId: string, dto: IngestMentionDto) {
    return this.mentionIngest.ingestMention(companyId, dto);
  }

  ingestLink(companyId: string, dto: IngestLinkDto) {
    return this.linkIngest.ingestLink(companyId, dto);
  }
}
