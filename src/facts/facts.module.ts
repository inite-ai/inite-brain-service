import { Module } from '@nestjs/common';
import { FactsController } from './facts.controller';
import { FactsService } from './facts.service';

@Module({
  controllers: [FactsController],
  providers: [FactsService],
  exports: [FactsService],
})
export class FactsModule {}
