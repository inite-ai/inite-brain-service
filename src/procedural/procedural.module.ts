import { Module } from '@nestjs/common';
import { ProceduralMemoryService } from './procedural-memory.service';

@Module({
  providers: [ProceduralMemoryService],
  exports: [ProceduralMemoryService],
})
export class ProceduralModule {}
