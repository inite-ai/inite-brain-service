import { Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceSpan } from '../common/debug-trace';
import { MentionExtractionService } from './mention-extraction.service';
import { MentionPersistService } from './mention-persist.service';

/**
 * The mention ingest path (`ingestMention`): free-text → LLM extraction → fact
 * records. Orchestrates the extract stage (outside the db session) and the
 * persist stage (inside it), and owns the ingest-mention metric counter
 * (skipped / extracted / failed).
 */
@Injectable()
export class MentionIngestService {
  constructor(
    private readonly extraction: MentionExtractionService,
    private readonly persist: MentionPersistService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async ingestMention(companyId: string, dto: IngestMentionDto) {
    try {
      return await this.run(companyId, dto);
    } catch (err) {
      // Record the failure on the metric counter before re-throwing so the
      // operator sees mention-ingest-failure spikes without grepping logs.
      this.metrics?.countIngestMention('failed');
      throw err;
    }
  }

  private run(companyId: string, dto: IngestMentionDto) {
    return traceSpan('ingest.mention', async () => {
      const prep = await this.extraction.prepare(companyId, dto);
      if (prep.skip) {
        this.metrics?.countIngestMention('skipped');
        return {
          skipped: true,
          reason: prep.skip,
          extractedEntityIds: [],
          extractedFactIds: [],
        };
      }

      const out = await this.persist.persistAll({
        companyId,
        dto,
        extraction: prep.extraction,
        source: prep.source,
        factEmbeddings: prep.factEmbeddings,
      });

      this.metrics?.countIngestMention('extracted');
      return { skipped: false, ...out };
    });
  }
}
