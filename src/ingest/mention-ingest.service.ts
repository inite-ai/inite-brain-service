import { Injectable, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceSpan } from '../common/debug-trace';
import { MentionExtractionService } from './mention-extraction.service';
import { MentionPersistService } from './mention-persist.service';
import { EpisodeStoreService } from './episode-store.service';
import { envFlagEnabled } from '../common/env-validation';
import { pinUserScope } from '../auth/user-scope';

/**
 * The mention ingest path (`ingestMention`): free-text → LLM extraction → fact
 * records. Orchestrates the extract stage (outside the db session) and the
 * persist stage (inside it), and owns the ingest-mention metric counter
 * (skipped / extracted / failed).
 */
@Injectable()
export class MentionIngestService {
  // Fourth dep is the flag-gated L0 episode capture; both trailing deps are
  // optional so positionally-constructed unit tests stay two-argument.
  // eslint-disable-next-line max-params
  constructor(
    private readonly extraction: MentionExtractionService,
    private readonly persist: MentionPersistService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly episodes?: EpisodeStoreService,
  ) {}

  async ingestMention(companyId: string, dto: IngestMentionDto) {
    // Audit 2026-08-21 P0: pin the per-user scope at the entry — a
    // user-bound token writes ONLY its own user's slice (mismatch 403,
    // omitted → the token's user); M2M assertions pass through. The
    // pinned value rides the dto into episode capture and every
    // extracted fact (same seam as fact-ingest / search / synthesize).
    dto = { ...dto, userId: pinUserScope(dto.userId) };
    // G9 write-anomaly signal: one increment per mention write attempt,
    // fired at the surface entry (before extraction can fail) so a
    // poisoning burst is visible as a rate spike on the `mention` path.
    this.metrics?.countIngestWrite('mention');
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
      // L0 episode capture (EPISODE_SUBSTRATE_ENABLED) runs BEFORE
      // extraction, so an extractor failure or skip no longer loses the
      // turn forever. Non-fatal by contract; idempotent on retry.
      await this.episodes?.captureTurn(companyId, dto);

      // Episode-only mode (INGEST_EPISODE_ONLY): capture the raw turn and
      // stop — no LLM extraction, no fact persistence. The readable world
      // is built later by the window deriver + segment composer over L0.
      // LLM-free archive ingestion; requires the substrate flag to be on
      // to be useful.
      if (envFlagEnabled(process.env.INGEST_EPISODE_ONLY)) {
        this.metrics?.countIngestMention('skipped');
        return {
          skipped: true,
          reason: 'episode_only',
          extractedEntityIds: [],
          extractedFactIds: [],
        };
      }

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
