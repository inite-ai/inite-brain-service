import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EpisodeReadStoreService } from './episode-read-store.service';
import { EpisodeSubscriptionService } from './episode-subscription.service';
import { EpisodesController } from './episodes.controller';
import { ProjectionRegistryService } from './projection-registry.service';

/**
 * Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md).
 * Owns the read port over the L0 episode substrate, the public episodes
 * API (surface 1), and the projection registry (surface 3). The write
 * side stays in ingest; the projections REST verb lives in AdminModule
 * next to the deriver it drives.
 */
@Module({
  imports: [AuthModule],
  controllers: [EpisodesController],
  providers: [
    EpisodeReadStoreService,
    ProjectionRegistryService,
    EpisodeSubscriptionService,
  ],
  exports: [EpisodeReadStoreService, ProjectionRegistryService],
})
export class EpisodesModule {}
