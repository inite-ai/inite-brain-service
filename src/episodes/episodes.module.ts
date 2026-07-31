import { Module } from '@nestjs/common';
import { EpisodeReadStoreService } from './episode-read-store.service';

/**
 * Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md).
 * Owns the read port over the L0 episode substrate; the public episodes
 * API (surface 1) mounts here too. The write side stays in ingest.
 */
@Module({
  providers: [EpisodeReadStoreService],
  exports: [EpisodeReadStoreService],
})
export class EpisodesModule {}
