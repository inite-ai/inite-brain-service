import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { IngestMentionDto } from './dto/ingest-mention.dto';
import { traceSpan } from '../common/debug-trace';
import { MentionExtractionService } from './mention-extraction.service';
import { MentionPersistService } from './mention-persist.service';
import { EpisodeStoreService } from './episode-store.service';
import { MentionProjectionService } from './mention-projection.service';
import { envFlagEnabled } from '../common/env-validation';
import { failClosedCaptureEnabled } from '../common/evidence-flags';
import { pinUserScope } from '../auth/user-scope';
import type { ExtractionResult } from '../ai/extractor.service';

/**
 * The mention ingest path (`ingestMention`): free-text → LLM extraction → fact
 * records. Orchestrates the extract stage (outside the db session) and the
 * persist stage (inside it), and owns the ingest-mention metric counter
 * (skipped / extracted / failed).
 */
@Injectable()
export class MentionIngestService {
  private readonly logger = new Logger(MentionIngestService.name);

  // Fourth dep is the flag-gated L0 episode capture, fifth the flag-gated
  // pack scene projection; the trailing deps are optional so
  // positionally-constructed unit tests stay two-argument.
  // eslint-disable-next-line max-params
  constructor(
    private readonly extraction: MentionExtractionService,
    private readonly persist: MentionPersistService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly episodes?: EpisodeStoreService,
    @Optional() private readonly projections?: MentionProjectionService,
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
      const episodeId = (await this.episodes?.captureTurn(companyId, dto)) ?? null;

      // Drift-1 fail-closed capture (EVIDENCE_FAIL_CLOSED_CAPTURE): no
      // extraction without a stored observation. A missing episode id —
      // substrate off, wiring absent, or a failed write — is a retryable
      // INFRA state, not a caller error, so 503 (the evidence-store
      // idiom); the ingestMention catch counts it on the 'failed' metric
      // before re-throwing. Flag off (default) ⇒ the capture result is
      // advisory exactly as before — byte-identical.
      if (failClosedCaptureEnabled() && !episodeId) {
        throw new ServiceUnavailableException(
          'episode capture unavailable — fail-closed ingest (EVIDENCE_FAIL_CLOSED_CAPTURE ' +
            'requires EPISODE_SUBSTRATE_ENABLED and a successful L0 episode write)',
        );
      }

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

      // The captured episode id is stamped into every extracted fact's
      // source, so the fact can be walked back to the turn it came from
      // (the grounding stamp, EVIDENCE_GROUNDING_STAMP, then reads it as
      // observational).
      //
      // This used to require EVIDENCE_FAIL_CLOSED_CAPTURE, which is a
      // different question: that flag decides whether ingest REFUSES a
      // turn it could not capture, not whether a captured turn is worth
      // linking. Coupling them meant that on a default deployment every
      // episode was stored, every fact was stored, and no fact pointed
      // at its episode — GET /v1/facts/:id/provenance answered `[]` for
      // the entire mention path. Found by the memory-fitness battery,
      // D3 at 0/3 with 12 facts walked and not one episode behind them.
      //
      // No episode id (substrate off, or a failed write) ⇒ the same
      // source object rides through untouched, as before.
      const source = episodeId ? { ...prep.source, episodeIds: [episodeId] } : prep.source;

      const out = await this.persist.persistAll({
        companyId,
        dto,
        extraction: prep.extraction,
        source,
        factEmbeddings: prep.factEmbeddings,
      });

      // Capture-path pack memory projections (0110,
      // PACK_MEMORY_PROJECTIONS_ENABLED): the mention-origin producer for
      // packs that declare a memoryModel. Runs AFTER persistence — the
      // semantic write has already landed and must not be retracted by an
      // optional shadow pass — and only for a CAPTURED turn (the episode
      // id is the projection's GDPR erasure anchor).
      if (episodeId) {
        await this.projectPackScenes({
          companyId,
          dto,
          episodeId,
          extraction: prep.extraction,
        });
      }

      this.metrics?.countIngestMention('extracted');
      return { skipped: false, ...out };
    });
  }

  /**
   * Soft-fail by contract (the episode-capture idiom): a shadow
   * projection can never fail — or slow the failure of — a mention whose
   * facts are already written. Flag off ⇒ projectTurn returns before any
   * IO, so this is a bare call and a no-op.
   */
  private async projectPackScenes(p: {
    companyId: string;
    dto: IngestMentionDto;
    episodeId: string;
    extraction: ExtractionResult;
  }): Promise<void> {
    try {
      await this.projections?.projectTurn({
        companyId: p.companyId,
        dto: p.dto,
        episodeId: p.episodeId,
        // Advisory subject for derived state deltas — the turn's first
        // extracted entity, else the stateModel's own subjectType.
        subject: p.extraction.entities[0]?.name,
      });
    } catch (e) {
      this.logger.warn(
        `pack scene projection failed for episode ${p.episodeId}: ${(e as Error).message}`,
      );
    }
  }
}
