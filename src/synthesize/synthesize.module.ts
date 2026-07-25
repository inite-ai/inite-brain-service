import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { SynthesizeController } from './synthesize.controller';
import { SynthesizeService } from './synthesize.service';
import { EpisodeLaneService } from './episode-lane.service';

@Module({
  imports: [SearchModule],
  controllers: [SynthesizeController],
  providers: [SynthesizeService, EpisodeLaneService],
  exports: [SynthesizeService],
})
export class SynthesizeModule {}
