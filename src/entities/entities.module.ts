import { Module } from '@nestjs/common';
import { EntitiesController } from './entities.controller';
import { EntitiesService } from './entities.service';
import { EntityForgetService } from './entity-forget.service';
import { UserForgetController } from './user-forget.controller';
import { UserForgetService } from './user-forget.service';
import { EvidenceModule } from '../evidence/evidence.module';
import { IngestCoreModule } from '../ingest/ingest-core.module';
import { ScopedEntityConsolidationService } from './scoped-entity-consolidation.service';

@Module({
  // EvidenceModule: user-forget's evidence-blob deletion hook (0109).
  // IngestCoreModule: the entity upsert rules the consolidation pass
  // reuses (adopt-by-name) and the one edge primitive.
  imports: [EvidenceModule, IngestCoreModule],
  controllers: [EntitiesController, UserForgetController],
  providers: [
    EntitiesService,
    EntityForgetService,
    UserForgetService,
    ScopedEntityConsolidationService,
  ],
  exports: [EntitiesService, ScopedEntityConsolidationService],
})
export class EntitiesModule {}
