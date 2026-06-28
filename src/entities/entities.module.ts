import { Module } from '@nestjs/common';
import { EntitiesController } from './entities.controller';
import { EntitiesService } from './entities.service';
import { EntityForgetService } from './entity-forget.service';

@Module({
  controllers: [EntitiesController],
  providers: [EntitiesService, EntityForgetService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
