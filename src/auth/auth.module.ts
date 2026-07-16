import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { CredentialResolverService } from './credential-resolver.service';
import { JwksService } from './jwks.service';
import { ProtectedResourceController } from './protected-resource.controller';

@Global()
@Module({
  controllers: [ProtectedResourceController],
  providers: [
    ApiKeyService,
    JwksService,
    CredentialResolverService,
    ApiKeyGuard,
  ],
  exports: [
    ApiKeyService,
    JwksService,
    CredentialResolverService,
    ApiKeyGuard,
  ],
})
export class AuthModule {}
