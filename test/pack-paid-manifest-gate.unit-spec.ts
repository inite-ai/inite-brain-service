/**
 * The paid-pack gate on the two doors beside resolveForInstall.
 *
 * Before this, a paid pack was bought by reading it: any brain:read key
 * fetched the full manifest from GET /v1/registry/packs/:packId/:version,
 * and a brain:admin key posted it back to POST /v1/admin/packs, which
 * installed it without asking billing. Both doors now answer the same
 * 402 the from-registry install does, and the publisher still reads and
 * installs its own pack.
 */
import { HttpException } from '@nestjs/common';
import { PackPurchaseGateService } from '../src/registry/pack-purchase-gate.service';
import { PackRegistryService } from '../src/registry/pack-registry.service';
import { AdminPacksController } from '../src/admin/admin-packs.controller';
import type { RegistryMetaService } from '../src/registry/registry-meta.service';
import type { BillingClientService } from '../src/billing/billing-client.service';
import type { PackMarketplaceMeta } from '../src/registry/marketplace-meta';
import type { SurrealService } from '../src/db/surreal.service';
import type { DomainPackInstallService } from '../src/admin/domain-pack-install.service';
import type { PackEvalService } from '../src/admin/pack-eval.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';
import type { DomainPackManifest } from '../src/ai/domain-packs';

const PAID: PackMarketplaceMeta = {
  packId: 'fintech',
  featured: false,
  featuredAt: null,
  paid: true,
  priceCode: 'pack_fintech_1700000000',
  displayPrice: { amount: 2900, currency: 'USD' },
};

function gate(args: {
  meta: PackMarketplaceMeta | null;
  billingEnabled?: boolean;
  entitled?: boolean;
  publisher?: string;
}): { gate: PackPurchaseGateService; entitlementLookups: () => number } {
  let lookups = 0;
  const meta = {
    getMeta: async () => args.meta,
    isPublishedBy: async ({ companyId }: { companyId: string }) => companyId === args.publisher,
  } as unknown as RegistryMetaService;
  const billing = {
    enabled: () => args.billingEnabled ?? true,
    hasEntitlement: async () => {
      lookups++;
      return args.entitled ?? false;
    },
  } as unknown as BillingClientService;
  return { gate: new PackPurchaseGateService(meta, billing), entitlementLookups: () => lookups };
}

async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof HttpException) return e.getStatus();
    throw e;
  }
}

const buyer = { companyId: 'co_buyer', packId: 'fintech' };

describe('PackPurchaseGateService.assertAccessible', () => {
  it('passes a free pack', async () => {
    expect(await statusOf(gate({ meta: null }).gate.assertAccessible(buyer))).toBe('ok');
  });

  it('passes a paid pack while billing is off (self-hosted = free)', async () => {
    const g = gate({ meta: PAID, billingEnabled: false });
    expect(await statusOf(g.gate.assertAccessible(buyer))).toBe('ok');
  });

  it('402s a paid pack for a company with no entitlement', async () => {
    expect(await statusOf(gate({ meta: PAID }).gate.assertAccessible(buyer))).toBe(402);
  });

  it('passes a paid pack for a company that bought it', async () => {
    expect(await statusOf(gate({ meta: PAID, entitled: true }).gate.assertAccessible(buyer))).toBe(
      'ok',
    );
  });

  it('passes the publisher without asking billing', async () => {
    const g = gate({ meta: PAID, publisher: 'co_buyer' });
    expect(await statusOf(g.gate.assertAccessible(buyer))).toBe('ok');
    expect(g.entitlementLookups()).toBe(0);
  });
});

function registryOver(
  rows: Array<Record<string, unknown>>,
  purchaseGate: PackPurchaseGateService,
): PackRegistryService {
  const surreal = {
    withAdminDb: async (fn: (db: unknown) => Promise<unknown>) => fn({ query: async () => [rows] }),
  } as unknown as SurrealService;
  return new PackRegistryService(surreal, purchaseGate);
}

const row = {
  packId: 'fintech',
  version: '1.0.0',
  manifest: { id: 'fintech', version: '1.0.0', predicates: [] },
  checksum: 'abc',
  publishedAt: '2026-10-01T00:00:00.000Z',
};

describe('PackRegistryService.getManifest — the read door', () => {
  it('402s a paid manifest for a company that has not bought it', async () => {
    const registry = registryOver([row], gate({ meta: PAID }).gate);
    expect(await statusOf(registry.getManifest('fintech', '1.0.0', { companyId: 'co_x' }))).toBe(
      402,
    );
  });

  it('serves a paid manifest to a buyer', async () => {
    const registry = registryOver([row], gate({ meta: PAID, entitled: true }).gate);
    const out = await registry.getManifest('fintech', '1.0.0', { companyId: 'co_x' });
    expect(out?.manifest).toEqual(row.manifest);
  });

  it('serves a free manifest to anyone', async () => {
    const registry = registryOver([row], gate({ meta: null }).gate);
    const out = await registry.getManifest('fintech', undefined, { companyId: 'co_x' });
    expect(out?.version).toBe('1.0.0');
  });

  it('still answers null for an unknown pack, before asking billing', async () => {
    const g = gate({ meta: PAID });
    const registry = registryOver([], g.gate);
    expect(await registry.getManifest('nope', '1.0.0', { companyId: 'co_x' })).toBeNull();
    expect(g.entitlementLookups()).toBe(0);
  });
});

describe('AdminPacksController.install — the pasted-manifest door', () => {
  function controller(purchaseGate: PackPurchaseGateService): {
    ctl: AdminPacksController;
    installs: () => number;
  } {
    let installs = 0;
    const svc = {
      install: async () => {
        installs++;
        return { packId: 'fintech', version: '1.0.0', predicatesSeeded: 0, checksum: 'abc' };
      },
    } as unknown as DomainPackInstallService;
    const registry = registryOver([row], purchaseGate);
    const ctl = new AdminPacksController(svc, registry, {} as unknown as PackEvalService);
    return { ctl, installs: () => installs };
  }
  const req = { brainAuth: { companyId: 'co_x' } } as AuthenticatedRequest;
  const manifest = row.manifest as unknown as DomainPackManifest;

  it('402s a paid pack id and never reaches the installer', async () => {
    const c = controller(gate({ meta: PAID }).gate);
    expect(await statusOf(c.ctl.install(req, { manifest }))).toBe(402);
    expect(c.installs()).toBe(0);
  });

  it('installs a paid pack id for a buyer', async () => {
    const c = controller(gate({ meta: PAID, entitled: true }).gate);
    expect(await statusOf(c.ctl.install(req, { manifest }))).toBe('ok');
    expect(c.installs()).toBe(1);
  });

  it('installs a pack the registry does not sell', async () => {
    const c = controller(gate({ meta: null }).gate);
    expect(await statusOf(c.ctl.install(req, { manifest }))).toBe('ok');
    expect(c.installs()).toBe(1);
  });
});
