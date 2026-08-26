import { Module } from '@nestjs/common';
import { EntitiesController } from './entities.controller';
import { EntitiesService } from './entities.service';
import { EntityForgetService } from './entity-forget.service';
import { UserForgetController } from './user-forget.controller';
import { UserForgetService } from './user-forget.service';
import { EvidenceModule } from '../evidence/evidence.module';

@Module({
  // EvidenceModule: user-forget's evidence-blob deletion hook (0109).
  imports: [EvidenceModule],
  controllers: [EntitiesController, UserForgetController],
  providers: [EntitiesService, EntityForgetService, UserForgetService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
