import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { CredentialResolverService } from './credential-resolver.service';
import { JwksService } from './jwks.service';
import { ProtectedResourceController } from './protected-resource.controller';
import { RevocationCacheService } from './revocation-cache.service';
import { SsfReceiverService } from './ssf-receiver.service';
import { TenantRegistryService } from './tenant-registry.service';

@Global()
@Module({
  controllers: [ProtectedResourceController],
  providers: [
    ApiKeyService,
    JwksService,
    CredentialResolverService,
    ApiKeyGuard,
    RevocationCacheService,
    SsfReceiverService,
    TenantRegistryService,
  ],
  exports: [
    ApiKeyService,
    JwksService,
    CredentialResolverService,
    ApiKeyGuard,
    RevocationCacheService,
    TenantRegistryService,
  ],
})
export class AuthModule {}
