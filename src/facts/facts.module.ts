import { Module } from '@nestjs/common';
import { EpisodesModule } from '../episodes/episodes.module';
import { FactsController } from './facts.controller';
import { FactsService } from './facts.service';
import { FactSourceTurnsService } from './fact-source-turns.service';

@Module({
  // EpisodesModule supplies the L0 read port (EpisodeReadStoreService)
  // the provenance surface fetches grounding turns through — one PII
  // fence + user gate implementation, shared with the synthesize lanes.
  imports: [EpisodesModule],
  controllers: [FactsController],
  providers: [FactsService, FactSourceTurnsService],
  exports: [FactsService, FactSourceTurnsService],
})
export class FactsModule {}
