import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { JwksService } from './jwks.service';

@Global()
@Module({
  providers: [ApiKeyService, JwksService, ApiKeyGuard],
  exports: [ApiKeyService, JwksService, ApiKeyGuard],
})
export class AuthModule {}
