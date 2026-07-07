import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PackRegistryService } from './pack-registry.service';
import { RegistryController } from './registry.controller';
import { AdminRegistryController } from './admin-registry.controller';
import { RegistryUiController } from './registry-ui.controller';

/**
 * The GLOBAL Domain Pack registry (docs/domain-packs.md): a shared catalogue of
 * publishable/installable packs stored in the system DB. Discovery reads
 * (RegistryController, brain:read) + publish/yank (AdminRegistryController,
 * registry:publish). PackRegistryService is exported so the tenant-facing
 * install path (AdminPacksController) can resolve manifests from the registry.
 * SurrealService is @Global; AuthModule supplies the ApiKeyGuard.
 */
@Module({
  imports: [AuthModule],
  controllers: [RegistryController, AdminRegistryController, RegistryUiController],
  providers: [PackRegistryService],
  exports: [PackRegistryService],
})
export class RegistryModule {}
