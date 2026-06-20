import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SurrealModule } from '../db/surreal.module';
import { ChangefeedConsumerService } from './changefeed-consumer.service';

/**
 * Audit module — owns the CHANGEFEED consumer (migration 0023). Kept
 * isolated so a feature flag can disable the whole subsystem without
 * touching unrelated modules.
 */
@Module({
  imports: [AuthModule, SurrealModule],
  providers: [ChangefeedConsumerService],
  exports: [ChangefeedConsumerService],
})
export class AuditModule {}
