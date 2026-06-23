import { Module } from '@nestjs/common';
import { MemoryDiffService } from './memory-diff.service';

@Module({
  providers: [MemoryDiffService],
  exports: [MemoryDiffService],
})
export class DiffModule {}
