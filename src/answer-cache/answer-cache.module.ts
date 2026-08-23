import { Module } from '@nestjs/common';
import { EpisodesModule } from '../episodes/episodes.module';
import { AnswerCacheService } from './answer-cache.service';

/**
 * G1 answer-reuse cache (docs/roadmap/sota-gap-build-2026-08.md):
 * exact-normalized-match serving of verified grounded answers, gated by
 * check-on-read over the cited facts' lifecycle state. EpisodesModule
 * supplies the ReadPinService the cache key's derived-world component
 * resolves through; Surreal/Metrics/PredicateRegistry arrive via their
 * global modules.
 */
@Module({
  imports: [EpisodesModule],
  providers: [AnswerCacheService],
  exports: [AnswerCacheService],
})
export class AnswerCacheModule {}
