import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';

/**
 * Per-user surfaces. v1 owns the rolling user profile read
 * (docs/user-profile-api.md) — a deterministic query-time projection
 * of one end-user's memory for prompt injection. GDPR user-forget
 * stays in EntitiesModule next to the entity cascade it reuses.
 */
@Module({
  // EpisodesModule supplies ReadPinService (the per-tenant derived-world
  // pin the profile's world fence resolves through).
  imports: [AuthModule, EpisodesModule],
  controllers: [UserProfileController],
  providers: [UserProfileService],
})
export class UsersModule {}
