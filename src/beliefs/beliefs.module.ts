import { Module } from '@nestjs/common';
import { BeliefsController } from './beliefs.controller';
import { BeliefsService } from './beliefs.service';

@Module({
  controllers: [BeliefsController],
  providers: [BeliefsService],
  exports: [BeliefsService],
})
export class BeliefsModule {}
