import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestPredictionService } from './ingest-predictor.service';
import { PredictScoringService } from './predict-scoring.service';
import { EntityResolverService } from './entity-resolver.service';
import { EntityUpsertService } from './entity-upsert.service';
import { FactEmbeddingService } from './fact-embedding.service';
import { FactResolverService } from './fact-resolver.service';
import { FactIngestService } from './fact-ingest.service';
import { MentionExtractionService } from './mention-extraction.service';
import { MentionPersistService } from './mention-persist.service';
import { MentionIngestService } from './mention-ingest.service';
import { LinkIngestService } from './link-ingest.service';

@Module({
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestPredictionService,
    PredictScoringService,
    EntityResolverService,
    // Ingest pipeline collaborators (max-params split of IngestService):
    EntityUpsertService,
    FactEmbeddingService,
    FactResolverService,
    FactIngestService,
    MentionExtractionService,
    MentionPersistService,
    MentionIngestService,
    LinkIngestService,
  ],
  exports: [IngestService, IngestPredictionService],
})
export class IngestModule {}
