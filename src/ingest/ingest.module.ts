import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestPredictionService } from './ingest-predictor.service';
import { PredictScoringService } from './predict-scoring.service';
import { IngestCoreModule } from './ingest-core.module';
import { FactIngestService } from './fact-ingest.service';
import { MentionExtractionService } from './mention-extraction.service';
import { MentionPersistService } from './mention-persist.service';
import { MentionIngestService } from './mention-ingest.service';
import { EpisodeStoreService } from './episode-store.service';
import { LinkIngestService } from './link-ingest.service';

/**
 * The legacy ingest routes (fact / mention / link). Write primitives live
 * in IngestCoreModule (shared with the document pipeline — one decision
 * engine, no drift); DocumentsModule is imported for the
 * INGEST_MENTION_VIA_DOCUMENT wrapper (default off), which routes mention
 * traffic through the Source → Indexer → Candidates → Brain pipeline
 * while preserving the response shape.
 */
@Module({
  imports: [IngestCoreModule, DocumentsModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestPredictionService,
    PredictScoringService,
    FactIngestService,
    MentionExtractionService,
    MentionPersistService,
    MentionIngestService,
    EpisodeStoreService,
    LinkIngestService,
  ],
  exports: [IngestService, IngestPredictionService, IngestCoreModule],
})
export class IngestModule {}
