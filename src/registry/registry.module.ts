import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PackRegistryService } from './pack-registry.service';
import { RegistryController } from './registry.controller';
import { AdminRegistryController } from './admin-registry.controller';
import { MarketplaceAdminController } from './marketplace-admin.controller';
import { RegistryUiController } from './registry-ui.controller';
import { RegistryMirrorService } from './registry-mirror.service';
import { RegistryMetaService } from './registry-meta.service';
import { PackPurchaseGateService } from './pack-purchase-gate.service';
import { PublisherProfileService } from './publisher-profile.service';

/**
 * The GLOBAL Domain Pack registry (docs/domain-packs.md): a shared catalogue of
 * publishable/installable packs stored in the system DB. Discovery reads
 * (RegistryController, brain:read) + publish/yank (AdminRegistryController,
 * registry:publish) + marketplace writes (MarketplaceAdminController: pricing/
 * profiles registry:publish, curation registry:curate, checkout brain:admin).
 * PackRegistryService is exported so the tenant-facing install path
 * (AdminPacksController) can resolve manifests from the registry — its
 * paid-pack gate (PackPurchaseGateService → BillingModule) rides along.
 * RegistryMirrorService pull-syncs an upstream instance's catalogue when
 * REGISTRY_UPSTREAM_URL is set (inert otherwise); marketplace state
 * (registry_pack_meta / publisher_profile) is instance-local and never
 * mirrored. SurrealService is @Global; AuthModule supplies the ApiKeyGuard;
 * JobsModule (@Global) supplies the worker-loop/claim services the mirror
 * job uses.
 */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [
    RegistryController,
    AdminRegistryController,
    MarketplaceAdminController,
    RegistryUiController,
  ],
  providers: [
    PackRegistryService,
    RegistryMirrorService,
    RegistryMetaService,
    PackPurchaseGateService,
    PublisherProfileService,
  ],
  exports: [PackRegistryService],
})
export class RegistryModule {}
