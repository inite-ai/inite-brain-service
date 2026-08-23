/**
 * Billing-service client against a stubbed billing HTTP server
 * (http.createServer — no network beyond loopback, no Nest app).
 *
 * Covers the client's whole failure taxonomy (disabled / 4xx request /
 * timeout- and 5xx-unavailable with the read retry), the entitlement
 * TTL cache (+ never-served-stale + clear seam), the idempotent
 * product/price ensure paths, and the checkout body mapping
 * (userId := companyId, idempotency-key forwarded).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BillingClientService } from '../src/billing/billing-client.service';
import {
  BillingDisabledError,
  BillingRequestError,
  BillingUnavailableError,
} from '../src/billing/billing-errors';

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

describe('BillingClientService', () => {
  let server: Server;
  let base: string;
  let client: BillingClientService;

  // Mutable stub state, reset per test.
  let products: Array<{ id: string; code: string }>;
  let entitlements: Record<string, Array<{ key: string }>>;
  let failWithStatus: number | null;
  let delayMs: number;
  let seen: SeenRequest[];
  let nextId: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        const respond = (status: number, payload: unknown) => {
          const send = () => {
            try {
              res.statusCode = status;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(payload));
            } catch {
              // The client may have aborted (timeout test) — ignore.
            }
          };
          if (delayMs > 0) setTimeout(send, delayMs).unref();
          else send();
        };
        if (failWithStatus !== null) {
          return respond(failWithStatus, { message: 'stub failure' });
        }
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/v1/service/catalog/products') {
          return respond(200, products);
        }
        if (req.method === 'POST' && url === '/v1/service/catalog/products') {
          const b = body as { code: string };
          if (products.some((p) => p.code === b.code)) {
            return respond(400, {
              message: `Product with code '${b.code}' already exists`,
            });
          }
          const product = { id: `prod_${nextId++}`, ...(body as object) } as {
            id: string;
            code: string;
          };
          products.push(product);
          return respond(201, product);
        }
        if (req.method === 'POST' && url === '/v1/service/catalog/prices') {
          return respond(201, { id: `price_${nextId++}`, ...(body as object) });
        }
        if (req.method === 'POST' && url === '/v1/checkout/sessions') {
          return respond(201, {
            sessionId: `sess_${nextId++}`,
            checkoutUrl: 'https://billing.example/checkout/x',
          });
        }
        const ent = /^\/v1\/entitlements\/(.+)$/.exec(url);
        if (req.method === 'GET' && ent) {
          return respond(200, entitlements[decodeURIComponent(ent[1]!)] ?? []);
        }
        return respond(404, { message: 'no such stub route' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    products = [];
    entitlements = {};
    failWithStatus = null;
    delayMs = 0;
    seen = [];
    nextId = 1;
    process.env.DOMAIN_PACK_BILLING_ENABLED = '1';
    process.env.BILLING_SERVICE_URL = base;
    process.env.BILLING_SERVICE_API_KEY = 'svc-key-test';
    process.env.BILLING_TIMEOUT_MS = '500';
    process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS = '60000';
    client = new BillingClientService();
  });

  afterEach(() => {
    delete process.env.DOMAIN_PACK_BILLING_ENABLED;
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    delete process.env.BILLING_TIMEOUT_MS;
    delete process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS;
  });

  it('is disabled without the flag — requests throw BillingDisabledError', async () => {
    delete process.env.DOMAIN_PACK_BILLING_ENABLED;
    expect(client.enabled()).toBe(false);
    await expect(
      client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
    ).rejects.toBeInstanceOf(BillingDisabledError);
    expect(seen).toHaveLength(0);
  });

  it('sends the service key as x-api-key on every call', async () => {
    await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' });
    expect(seen[0]!.headers['x-api-key']).toBe('svc-key-test');
  });

  describe('hasEntitlement + cache', () => {
    it('answers from the entitlements listing and caches per company', async () => {
      entitlements.co_a = [{ key: 'domain_pack:x' }];
      expect(
        await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
      ).toBe(true);
      expect(
        await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:y' }),
      ).toBe(false);
      // Second lookup for the same company hit the cache, not the wire.
      expect(seen).toHaveLength(1);
      // A different company is its own cache entry.
      expect(
        await client.hasEntitlement({ companyId: 'co_b', key: 'domain_pack:x' }),
      ).toBe(false);
      expect(seen).toHaveLength(2);
    });

    it('clearEntitlementCache forces a refetch', async () => {
      await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' });
      client.clearEntitlementCache();
      entitlements.co_a = [{ key: 'domain_pack:x' }];
      expect(
        await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
      ).toBe(true);
      expect(seen).toHaveLength(2);
    });

    it('expires the cache after the TTL', async () => {
      process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS = '1';
      await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' });
      await new Promise((r) => setTimeout(r, 10));
      await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' });
      expect(seen).toHaveLength(2);
    });

    it('is NOT served stale: expired cache + billing down throws (fail-closed)', async () => {
      process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS = '1';
      entitlements.co_a = [{ key: 'domain_pack:x' }];
      await client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' });
      await new Promise((r) => setTimeout(r, 10));
      failWithStatus = 500;
      await expect(
        client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
      ).rejects.toBeInstanceOf(BillingUnavailableError);
    });
  });

  describe('failure taxonomy', () => {
    it('timeout → BillingUnavailableError', async () => {
      process.env.BILLING_TIMEOUT_MS = '50';
      delayMs = 2_000;
      await expect(
        client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
      ).rejects.toBeInstanceOf(BillingUnavailableError);
    });

    it('5xx → one read retry, then BillingUnavailableError', async () => {
      failWithStatus = 503;
      await expect(
        client.hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' }),
      ).rejects.toBeInstanceOf(BillingUnavailableError);
      expect(seen).toHaveLength(2); // initial + 1 retry
    });

    it('4xx → BillingRequestError immediately (no retry), status carried', async () => {
      failWithStatus = 403;
      const err = await client
        .hasEntitlement({ companyId: 'co_a', key: 'domain_pack:x' })
        .then(
          () => null,
          (e) => e as BillingRequestError,
        );
      expect(err).toBeInstanceOf(BillingRequestError);
      expect(err!.status).toBe(403);
      expect(seen).toHaveLength(1);
    });
  });

  describe('ensurePackProductAndPrice', () => {
    it('reuses an existing product and mints a fresh epoch-suffixed price', async () => {
      products.push({ id: 'prod_existing', code: 'pack_fintech' });
      const { productId, priceCode } = await client.ensurePackProductAndPrice({
        packId: 'fintech',
        amount: 2900,
        currency: 'USD',
      });
      expect(productId).toBe('prod_existing');
      expect(priceCode).toMatch(/^pack_fintech_\d+$/);
      const creates = seen.filter(
        (r) => r.method === 'POST' && r.url === '/v1/service/catalog/products',
      );
      expect(creates).toHaveLength(0);
      const price = seen.find(
        (r) => r.method === 'POST' && r.url === '/v1/service/catalog/prices',
      );
      expect(price?.body).toMatchObject({
        code: priceCode,
        productId: 'prod_existing',
        amount: 2900,
        currency: 'USD',
      });
    });

    it('creates the product when absent — one_time + entitlement metadata', async () => {
      const { productId } = await client.ensurePackProductAndPrice({
        packId: 'fintech',
        amount: 500,
        currency: 'EUR',
      });
      const create = seen.find(
        (r) => r.method === 'POST' && r.url === '/v1/service/catalog/products',
      );
      expect(create?.body).toMatchObject({
        code: 'pack_fintech',
        type: 'one_time',
        metadata: { entitlements: ['domain_pack:fintech'] },
      });
      expect(productId).toMatch(/^prod_/);
    });
  });

  describe('createCheckoutSession', () => {
    it('maps companyId → billing userId and forwards the idempotency key', async () => {
      const res = await client.createCheckoutSession({
        companyId: 'co_buyer',
        priceCode: 'pack_fintech_1',
        packId: 'fintech',
        successUrl: 'https://app.example/ok',
        idempotencyKey: 'idem-123',
      });
      expect(res.sessionId).toMatch(/^sess_/);
      expect(res.checkoutUrl).toContain('https://');
      const call = seen.find((r) => r.url === '/v1/checkout/sessions')!;
      expect(call.headers['idempotency-key']).toBe('idem-123');
      expect(call.body).toMatchObject({
        priceCode: 'pack_fintech_1',
        mode: 'PAYMENT',
        userId: 'co_buyer',
        successUrl: 'https://app.example/ok',
        metadata: {
          packId: 'fintech',
          companyId: 'co_buyer',
          source: 'brain_marketplace',
        },
      });
      // errorUrl omitted → not sent (billing validates IsUrl when present).
      expect('errorUrl' in (call.body as object)).toBe(false);
    });
  });
});
