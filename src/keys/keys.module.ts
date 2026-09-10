import { Module } from '@nestjs/common';
import { KeysController } from './keys.controller';
import { KeysService } from './keys.service';

/**
 * ApiKeyStoreService itself lives in the (global) AuthModule, because
 * credential resolution needs it on the hot path; this module only adds
 * the HTTP surface and the issuing rules.
 */
@Module({
  controllers: [KeysController],
  providers: [KeysService],
  exports: [KeysService],
})
export class KeysModule {}
