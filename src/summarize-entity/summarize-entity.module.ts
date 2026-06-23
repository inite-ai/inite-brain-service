import { Module } from '@nestjs/common';
import { SummarizeEntityService } from './summarize-entity.service';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [EntitiesModule],
  providers: [SummarizeEntityService],
  exports: [SummarizeEntityService],
})
export class SummarizeEntityModule {}
