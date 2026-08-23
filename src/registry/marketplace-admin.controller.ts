import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { BillingClientService } from '../billing/billing-client.service';
import {
  BillingDisabledError,
  BillingRequestError,
  BillingUnavailableError,
} from '../billing/billing-errors';
import { RegistryMetaService } from './registry-meta.service';
import { PublisherProfileService } from './publisher-profile.service';
import { isHttpUrl } from './marketplace-meta';
import type {
  CheckoutRequest,
  CheckoutResponse,
  FeatureResponse,
  PackPricingResponse,
  PublisherProfile,
  SetPricingRequest,
  UpsertPublisherProfileRequest,
} from '../contracts/registry/marketplace.schema';

const CURRENCY = /^[A-Za-z]{3}$/;

/**
 * Marketplace writes over the GLOBAL pack registry (docs/domain-packs.md
 * "Marketplace") — pricing + publisher profiles (registry:publish, the
 * publisher-facing scope), featured curation (registry:curate, the
 * hosting-operator scope) and the paid-pack checkout (brain:admin — the
 * BUYING tenant, same scope that installs). All state is instance-local
 * (registry_pack_meta / publisher_profile, migrations 0066/0067): never
 * part of the signed manifest, never mirrored.
 */
@Controller('v1/admin/registry')
@UseGuards(ApiKeyGuard)
export class MarketplaceAdminController {
  constructor(
    private readonly meta: RegistryMetaService,
    private readonly profiles: PublisherProfileService,
    private readonly billing: BillingClientService,
  ) {}

  /** Price a pack (publisher-owned): ensures the billing product exists,
   *  mints a fresh immutable price, then flips the registry meta. */
  @Put('packs/:packId/pricing')
  @RequireScopes('registry:publish')
  @PolicyAction('rest.registry.pricing.set')
  async setPricing(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
    @Body() body: SetPricingRequest,
  ): Promise<PackPricingResponse> {
    const amount = body?.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'amount must be a positive integer in minor units (e.g. cents)',
      );
    }
    if (typeof body?.currency !== 'string' || !CURRENCY.test(body.currency)) {
      throw new BadRequestException(
        'currency must be a 3-letter ISO 4217 code',
      );
    }
    const currency = body.currency.toUpperCase();
    const companyId = req.brainAuth.companyId;
    await this.meta.assertPublisherOwnsPack({ packId, companyId });
    const { priceCode } = await this.billing
      .ensurePackProductAndPrice({ packId, amount, currency })
      .catch((e) => this.rethrowBilling(e));
    await this.meta.setPricing({ packId, companyId, priceCode, amount, currency });
    return { packId, paid: true, priceCode, displayPrice: { amount, currency } };
  }

  /** Back to free (publisher-owned). Billing products/prices stay —
   *  only the registry stops gating installs on them. */
  @Delete('packs/:packId/pricing')
  @RequireScopes('registry:publish')
  @PolicyAction('rest.registry.pricing.clear')
  async clearPricing(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
  ): Promise<PackPricingResponse> {
    const companyId = req.brainAuth.companyId;
    await this.meta.assertPublisherOwnsPack({ packId, companyId });
    await this.meta.clearPricing({ packId, companyId });
    return { packId, paid: false };
  }

  @Post('packs/:packId/feature')
  @RequireScopes('registry:curate')
  @PolicyAction('rest.registry.feature')
  async feature(@Param('packId') packId: string): Promise<FeatureResponse> {
    await this.meta.setFeatured({ packId, featured: true });
    return { packId, featured: true };
  }

  @Post('packs/:packId/unfeature')
  @RequireScopes('registry:curate')
  @PolicyAction('rest.registry.unfeature')
  async unfeature(@Param('packId') packId: string): Promise<FeatureResponse> {
    await this.meta.setFeatured({ packId, featured: false });
    return { packId, featured: false };
  }

  /** Publisher public profile — writable only with ≥1 VERIFIED pack
   *  published under the publisher id (PublisherProfileService rule). */
  @Put('publishers/:publisher')
  @RequireScopes('registry:publish')
  @PolicyAction('rest.registry.publisher.upsert')
  async upsertPublisher(
    @Req() req: AuthenticatedRequest,
    @Param('publisher') publisher: string,
    @Body() body: UpsertPublisherProfileRequest,
  ): Promise<PublisherProfile> {
    return this.profiles.upsert({
      publisher,
      companyId: req.brainAuth.companyId,
      profile: {
        displayName: body?.displayName,
        ...(body?.url !== undefined ? { url: body.url } : {}),
        ...(body?.bio !== undefined ? { bio: body.bio } : {}),
        ...(body?.contactEmail !== undefined
          ? { contactEmail: body.contactEmail }
          : {}),
      },
    });
  }

  /** Start a hosted checkout for a paid pack. The buying tenant opens
   *  checkoutUrl, pays, then simply retries the install (the 402 hint on
   *  POST /v1/admin/packs/from-registry points here). */
  // eslint-disable-next-line max-params -- decorated HTTP route handler; each param is a @Req/@Param/@Body/@Headers binding, cannot be folded into an options object without breaking Nest param resolution
  @Post('packs/:packId/checkout')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireScopes('brain:admin')
  @PolicyAction('rest.registry.checkout')
  async checkout(
    @Req() req: AuthenticatedRequest,
    @Param('packId') packId: string,
    @Body() body: CheckoutRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CheckoutResponse> {
    for (const [name, value] of [
      ['successUrl', body?.successUrl],
      ['errorUrl', body?.errorUrl],
    ] as const) {
      if (value !== undefined && !isHttpUrl(value)) {
        throw new BadRequestException(`${name} must be a valid http(s) URL`);
      }
    }
    if (!this.billing.enabled()) {
      throw new BadRequestException(
        'billing integration is disabled on this instance',
      );
    }
    const meta = await this.meta.getMeta(packId);
    if (!meta?.paid || !meta.priceCode) {
      if (!(await this.meta.packExists(packId))) {
        throw new NotFoundException(
          `pack "${packId}" not found in the registry`,
        );
      }
      throw new BadRequestException(
        `pack "${packId}" is free — install directly`,
      );
    }
    return this.billing
      .createCheckoutSession({
        companyId: req.brainAuth.companyId,
        priceCode: meta.priceCode,
        packId,
        ...(body?.successUrl !== undefined ? { successUrl: body.successUrl } : {}),
        ...(body?.errorUrl !== undefined ? { errorUrl: body.errorUrl } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
      .catch((e) => this.rethrowBilling(e));
  }

  /** Billing error taxonomy → HTTP: disabled 400, unreachable 503
   *  (fail-closed), billing-side 4xx 502 (we sent something it refused). */
  private rethrowBilling(e: unknown): never {
    if (e instanceof BillingDisabledError) {
      throw new BadRequestException(
        'billing integration is disabled on this instance',
      );
    }
    if (e instanceof BillingUnavailableError) {
      throw new ServiceUnavailableException(
        `billing service is unavailable — ${e.message}`,
      );
    }
    if (e instanceof BillingRequestError) {
      throw new BadGatewayException(
        `billing service rejected the request (HTTP ${e.status})`,
      );
    }
    throw e;
  }
}
