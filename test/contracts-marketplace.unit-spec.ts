/**
 * Wire-contract drift guard for the registry marketplace surface —
 * controller/gate responses parsed against the zod contracts
 * (src/contracts/registry/marketplace.schema.ts + PublisherResponse).
 */
import { HttpException } from '@nestjs/common';
import {
  CheckoutResponseSchema,
  FeatureResponseSchema,
  PackPricingResponseSchema,
  PaymentRequiredHintSchema,
  PublisherProfileSchema,
} from '../src/contracts/registry/marketplace.schema';
import {
  PublisherResponseSchema,
  RegistryListResponseSchema,
} from '../src/contracts/registry/registry.schema';
import { MarketplaceAdminController } from '../src/registry/marketplace-admin.controller';
import { RegistryController } from '../src/registry/registry.controller';
import { PackPurchaseGateService } from '../src/registry/pack-purchase-gate.service';
import type { RegistryMetaService } from '../src/registry/registry-meta.service';
import type { PublisherProfileService } from '../src/registry/publisher-profile.service';
import type { BillingClientService } from '../src/billing/billing-client.service';
import type { PackRegistryService } from '../src/registry/pack-registry.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import type { PackMarketplaceMeta } from '../src/registry/marketplace-meta';
import type { PublisherProfile } from '../src/contracts/registry/marketplace.schema';

const req = { brainAuth: { companyId: 'co_test' } } as AuthenticatedRequest;

const paidMeta: PackMarketplaceMeta = {
  packId: 'fintech',
  featured: true,
  featuredAt: '2026-07-15T00:00:00.000Z',
  paid: true,
  priceCode: 'pack_fintech_1700000000',
  displayPrice: { amount: 2900, currency: 'USD' },
};

const profile: PublisherProfile = {
  publisher: 'acme',
  displayName: 'ACME Corp',
  url: 'https://acme.example',
  bio: 'We make packs.',
  contactEmail: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: null,
};

const summary = {
  packId: 'fintech',
  latestVersion: '0.1.0',
  description: 'financial services',
  keywords: ['finance'],
  publisher: 'acme',
  signed: true,
  verified: true,
  downloads: 3,
  publishedAt: '2026-07-01T12:00:00.000Z',
  versionCount: 1,
};

function fakeMeta(): RegistryMetaService {
  return {
    getMeta: async () => paidMeta,
    getMetaForPacks: async () => new Map([['fintech', paidMeta]]),
    setPricing: async () => undefined,
    clearPricing: async () => undefined,
    setFeatured: async () => undefined,
    assertPublisherOwnsPack: async () => undefined,
    packExists: async () => true,
  } as unknown as RegistryMetaService;
}

function fakeProfiles(): PublisherProfileService {
  return {
    get: async () => profile,
    upsert: async () => profile,
  } as unknown as PublisherProfileService;
}

function fakeBilling(): BillingClientService {
  return {
    enabled: () => true,
    ensurePackProductAndPrice: async () => ({
      productId: 'prod_1',
      priceCode: 'pack_fintech_1700000000',
    }),
    createCheckoutSession: async () => ({
      sessionId: 'sess_1',
      checkoutUrl: 'https://billing.example/checkout/sess_1',
    }),
    hasEntitlement: async () => false,
  } as unknown as BillingClientService;
}

function admin(): MarketplaceAdminController {
  return new MarketplaceAdminController(fakeMeta(), fakeProfiles(), fakeBilling());
}

function assertParses(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  value: unknown,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`contract drifted: ${JSON.stringify(parsed.error, null, 2)}`);
  }
}

describe('marketplace wire contracts', () => {
  it('PUT pricing matches PackPricingResponseSchema', async () => {
    assertParses(
      PackPricingResponseSchema,
      await admin().setPricing(req, 'fintech', { amount: 2900, currency: 'usd' }),
    );
  });

  it('DELETE pricing matches PackPricingResponseSchema', async () => {
    assertParses(PackPricingResponseSchema, await admin().clearPricing(req, 'fintech'));
  });

  it('feature/unfeature match FeatureResponseSchema', async () => {
    assertParses(FeatureResponseSchema, await admin().feature('fintech'));
    assertParses(FeatureResponseSchema, await admin().unfeature('fintech'));
  });

  it('PUT publisher profile matches PublisherProfileSchema', async () => {
    assertParses(
      PublisherProfileSchema,
      await admin().upsertPublisher(req, 'acme', { displayName: 'ACME Corp' }),
    );
  });

  it('checkout matches CheckoutResponseSchema', async () => {
    assertParses(CheckoutResponseSchema, await admin().checkout(req, 'fintech', {}, 'idem-1'));
  });

  it('the install 402 body matches PaymentRequiredHintSchema', async () => {
    const gate = new PackPurchaseGateService(fakeMeta(), fakeBilling());
    const err = await gate.assertInstallable({ companyId: 'co_test', packId: 'fintech' }).then(
      () => null,
      (e) => e as HttpException,
    );
    expect(err).toBeInstanceOf(HttpException);
    assertParses(PaymentRequiredHintSchema, err!.getResponse());
  });

  it('GET publisher matches PublisherResponseSchema (meta stamped on packs)', async () => {
    const registry = {
      list: async () => [summary],
    } as unknown as PackRegistryService;
    const controller = new RegistryController(registry, fakeMeta(), fakeProfiles());
    const res = await controller.publisher('acme');
    assertParses(PublisherResponseSchema, res);
    expect(res.packs[0]).toMatchObject({
      paid: true,
      featured: true,
      displayPrice: { amount: 2900, currency: 'USD' },
    });
  });

  it('the enriched catalogue listing still matches RegistryListResponseSchema', async () => {
    const registry = {
      list: async () => [summary],
    } as unknown as PackRegistryService;
    const controller = new RegistryController(registry, fakeMeta(), fakeProfiles());
    assertParses(RegistryListResponseSchema, await controller.list({}));
  });
});
