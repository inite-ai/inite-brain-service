import { Injectable, Logger, Optional } from '@nestjs/common';
import { gateCallerMeta } from '../common/caller-meta-gate';
import { envFlagEnabled } from '../common/env-validation';
import { MentionViaDocumentService } from '../documents/mention-via-document.service';
import { IngestFactDto } from './dto/ingest-fact.dto';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { IngestLinkDto } from './dto/ingest-link.dto';
import { IngestResult } from './ingest-result';
import { FactIngestService } from './fact-ingest.service';
import { MentionIngestService } from './mention-ingest.service';
import { LinkIngestService } from './link-ingest.service';

// Re-exported for callers that import the result types from this module.
export type {  IngestResult } from './ingest-result';

/**
 * Thin facade over the three ingest paths, each its own focused service:
 *  - {@link FactIngestService}    — typed direct ingest (`ingestFact`)
 *  - {@link MentionIngestService} — free-text → LLM extraction (`ingestMention`)
 *  - {@link LinkIngestService}    — edge / identity declaration (`ingestLink`)
 *
 * The shared per-fact write primitive lives in `FactResolverService`
 * (embed + policy + fn::resolve_fact + HyPE), entity resolution in
 * `EntityUpsertService`. This class only routes (and gates a mention's caller meta once, for
 * both of its paths); it holds no other logic.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly factIngest: FactIngestService,
    private readonly mentionIngest: MentionIngestService,
    private readonly linkIngest: LinkIngestService,
    @Optional() private readonly mentionViaDocument?: MentionViaDocumentService,
  ) {}

  ingestFact(companyId: string, dto: IngestFactDto): Promise<IngestResult> {
    return this.factIngest.ingestFact(companyId, dto);
  }

  /**
   * INGEST_MENTION_VIA_DOCUMENT: a mention goes through the document
   * pipeline — the same decision engine, and remembered at once with its
   * extraction read in the background. Decided HERE, for every caller (the
   * HTTP route, the source doors' conversation turns, the demo): deciding
   * it in the controller left every in-process caller on the direct path,
   * one synchronous extraction per turn.
   */
  ingestMention(companyId: string, dto: IngestMentionDto) {
    // Caller meta is checked HERE, once, before either path captures an
    // episode or stages a document: a refused bag is a 400 with nothing
    // written. In lax mode (SOURCE_META_STRICT=0) the clean remainder
    // rides on.
    if (dto.meta !== undefined) {
      const meta = gateCallerMeta(dto.meta, {
        warn: (count, first) =>
          this.logger.warn(`mention meta partially dropped (${count} issue(s)): ${first}`),
      });
      const { meta: _raw, ...rest } = dto;
      dto = meta ? { ...rest, meta } : rest;
    }
    if (this.mentionViaDocument && envFlagEnabled(process.env.INGEST_MENTION_VIA_DOCUMENT)) {
      return this.mentionViaDocument.ingest(companyId, dto);
    }
    return this.mentionIngest.ingestMention(companyId, dto);
  }

  ingestLink(companyId: string, dto: IngestLinkDto) {
    return this.linkIngest.ingestLink(companyId, dto);
  }
}
