import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { AffectController } from './affect.controller';
import { AffectPlaneService } from './affect-plane.service';
import { ConsentService } from './consent.service';
import { AffectReaderService } from './affect-reader.service';
import { AffectReadingWorkService } from './affect-reading-work.service';

/**
 * A person's emotional data as a category, and their consents per
 * purpose (#909). ConsentService is exported: a writer that processes for
 * a purpose asks it before it writes.
 */
@Module({
  imports: [AuthModule, AiModule],
  controllers: [AffectController],
  providers: [ConsentService, AffectPlaneService, AffectReaderService, AffectReadingWorkService],
  exports: [ConsentService, AffectPlaneService, AffectReaderService, AffectReadingWorkService],
})
export class AffectModule {}
