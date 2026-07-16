import { Module } from '@nestjs/common';
import { BillingClientService } from './billing-client.service';

/**
 * Client-side integration with the central billing service
 * (billing.inite.ai) — used by the registry marketplace for paid packs
 * (docs/domain-packs.md "Marketplace"). Inert unless
 * DOMAIN_PACK_BILLING_ENABLED is on; the client reads its env lazily
 * per call, so the module itself has no configuration.
 */
@Module({
  providers: [BillingClientService],
  exports: [BillingClientService],
})
export class BillingModule {}
