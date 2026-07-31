import { Module } from '@nestjs/common';
import { EpisodeReadStoreService } from './episode-read-store.service';
import { EpisodesController } from './episodes.controller';

/**
 * Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md).
 * Owns the read port over the L0 episode substrate and the public
 * episodes API (surface 1). The write side stays in ingest.
 */
@Module({
  controllers: [EpisodesController],
  providers: [EpisodeReadStoreService],
  exports: [EpisodeReadStoreService],
})
export class EpisodesModule {}
