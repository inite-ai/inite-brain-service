import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestPredictionService } from './ingest-predictor.service';
import { EntityResolverService } from './entity-resolver.service';

@Module({
  controllers: [IngestController],
  providers: [IngestService, IngestPredictionService, EntityResolverService],
  exports: [IngestService, IngestPredictionService],
})
export class IngestModule {}
