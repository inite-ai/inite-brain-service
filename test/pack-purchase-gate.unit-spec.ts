/**
 * Paid-pack install gate — the decision table over faked meta/billing
 * collaborators (src/registry/pack-purchase-gate.service.ts). The gate
 * sits in resolveForInstall, so every shape here is what
 * POST /v1/admin/packs/from-registry surfaces.
 */
import {
  BadGatewayException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PackPurchaseGateService } from '../src/registry/pack-purchase-gate.service';
import {
  BillingRequestError,
  BillingUnavailableError,
} from '../src/billing/billing-errors';
import type { RegistryMetaService } from '../src/registry/registry-meta.service';
import type { BillingClientService } from '../src/billing/billing-client.service';
import type { PackMarketplaceMeta } from '../src/registry/marketplace-meta';

function paidMeta(over: Partial<PackMarketplaceMeta> = {}): PackMarketplaceMeta {
  return {
    packId: 'fintech',
    featured: false,
    featuredAt: null,
    paid: true,
    priceCode: 'pack_fintech_1700000000',
    displayPrice: { amount: 2900, currency: 'USD' },
    ...over,
  };
}

function gate(args: {
  meta: PackMarketplaceMeta | null;
  billingEnabled?: boolean;
  entitled?: boolean | Error;
}): PackPurchaseGateService {
  const meta = {
    getMeta: async () => args.meta,
  } as unknown as RegistryMetaService;
  const billing = {
    enabled: () => args.billingEnabled ?? true,
    hasEntitlement: async () => {
      if (args.entitled instanceof Error) throw args.entitled;
      return args.entitled ?? false;
    },
  } as unknown as BillingClientService;
  return new PackPurchaseGateService(meta, billing);
}

const install = { companyId: 'co_buyer', packId: 'fintech' };

describe('PackPurchaseGateService.assertInstallable', () => {
  it('passes a pack with no meta row (free)', async () => {
    await expect(gate({ meta: null }).assertInstallable(install)).resolves.toBeUndefined();
  });

  it('passes a meta row with paid=false', async () => {
    await expect(
      gate({ meta: paidMeta({ paid: false }) }).assertInstallable(install),
    ).resolves.toBeUndefined();
  });

  it('passes a paid pack while billing is disabled (self-hosted = free)', async () => {
    await expect(
      gate({ meta: paidMeta(), billingEnabled: false }).assertInstallable(install),
    ).resolves.toBeUndefined();
  });

  it('passes a paid pack with an active entitlement', async () => {
    await expect(
      gate({ meta: paidMeta(), entitled: true }).assertInstallable(install),
    ).resolves.toBeUndefined();
  });

  it('402s an unentitled paid pack with the self-describing hint', async () => {
    const err = await gate({ meta: paidMeta(), entitled: false })
      .assertInstallable(install)
      .then(
        () => null,
        (e) => e as HttpException,
      );
    expect(err).toBeInstanceOf(HttpException);
    expect(err!.getStatus()).toBe(402);
    const body = err!.getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({
      statusCode: 402,
      error: 'Payment Required',
      packId: 'fintech',
      priceCode: 'pack_fintech_1700000000',
      displayPrice: { amount: 2900, currency: 'USD' },
      checkout: {
        method: 'POST',
        path: '/v1/admin/registry/packs/fintech/checkout',
      },
    });
    expect(String(body.message)).toContain('paid pack');
  });

  it('omits priceCode/displayPrice from the hint when the meta row lacks them', async () => {
    const err = await gate({
      meta: paidMeta({ priceCode: null, displayPrice: null }),
      entitled: false,
    })
      .assertInstallable(install)
      .then(
        () => null,
        (e) => e as HttpException,
      );
    const body = err!.getResponse() as Record<string, unknown>;
    expect('priceCode' in body).toBe(false);
    expect('displayPrice' in body).toBe(false);
  });

  it('503s (fail-closed) when billing is unreachable', async () => {
    await expect(
      gate({
        meta: paidMeta(),
        entitled: new BillingUnavailableError('boom'),
      }).assertInstallable(install),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('502s when billing rejects the entitlement lookup', async () => {
    await expect(
      gate({
        meta: paidMeta(),
        entitled: new BillingRequestError(400, 'bad user'),
      }).assertInstallable(install),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
