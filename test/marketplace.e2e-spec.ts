/**
 * Registry marketplace — end-to-end on a real DB with a stubbed billing
 * service (http.createServer).
 *
 * Proves the paid-pack product loop: price → discover (paid badge) →
 * install blocked with a self-describing 402 → checkout session →
 * entitlement granted → install succeeds (downloads counted exactly once,
 * never on the 402) — plus ownership fences (second company 403 on
 * pricing), un-pricing back to free, fail-closed 503 while billing is
 * down (free packs unaffected), featured curation behind registry:curate,
 * and verified-publisher profiles (JSON + public HTML).
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  REAL_ESTATE_PACK,
  signPack,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

// Distinct ids per run: the catalogue lives in the shared system DB and
// lingers across spec files / runs in one jest process.
const RUN = Date.now().toString(36);
const PAID_ID = `mkt_paid_${RUN}`;
const FREE_ID = `mkt_free_${RUN}`;
const PUBLISHER = `mkt_pub_${RUN}`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
const trusted = keypair();

describe('registry marketplace (e2e)', () => {
  let owner: AppFixture; // publisher company; main key: publish+admin (NO curate)
  let rival: AppFixture; // second company: publish+admin
  let curateKey: string; // owner extra key with registry:curate
  const auth = (f: AppFixture) => ({ Authorization: `Bearer ${f.apiKey}` });

  // ── billing stub ──────────────────────────────────────────────────────
  let server: Server;
  const billing = {
    products: [] as Array<{ id: string; code: string; metadata?: unknown }>,
    entitlements: {} as Record<string, Array<{ key: string }>>,
    checkouts: [] as Array<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>,
    failAll: false,
    nextId: 1,
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const json = (status: number, payload: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload));
        };
        if (billing.failAll) return json(500, { message: 'billing exploded' });
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/v1/service/catalog/products') {
          return json(200, billing.products);
        }
        if (req.method === 'POST' && url === '/v1/service/catalog/products') {
          const product = { id: `prod_${billing.nextId++}`, ...body } as {
            id: string;
            code: string;
          };
          billing.products.push(product);
          return json(201, product);
        }
        if (req.method === 'POST' && url === '/v1/service/catalog/prices') {
          return json(201, { id: `price_${billing.nextId++}`, ...body });
        }
        if (req.method === 'POST' && url === '/v1/checkout/sessions') {
          billing.checkouts.push({ headers: req.headers, body });
          return json(201, {
            sessionId: `sess_${billing.nextId++}`,
            checkoutUrl: 'https://billing.example/checkout/next',
          });
        }
        const ent = /^\/v1\/entitlements\/(.+)$/.exec(url);
        if (req.method === 'GET' && ent) {
          return json(
            200,
            billing.entitlements[decodeURIComponent(ent[1])] ?? [],
          );
        }
        return json(404, { message: 'no such stub route' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Billing + trust env BEFORE createApp (read lazily per call, but the
    // trust store must be valid for env validation and publish-time
    // verification). TTL 1ms = the entitlement cache never masks a grant
    // or a revocation inside the test flow.
    process.env.DOMAIN_PACK_BILLING_ENABLED = '1';
    process.env.BILLING_SERVICE_URL = base;
    process.env.BILLING_SERVICE_API_KEY = 'billing-e2e-key';
    process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS = '1';
    process.env.DOMAIN_PACK_TRUSTED_KEYS = JSON.stringify({
      [PUBLISHER]: trusted.pub,
    });

    owner = await createApp({
      companyId: `co_mkt_owner_${RUN}`,
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'registry:publish'],
      extraKeys: [{ scopes: ['registry:curate'] }],
    });
    curateKey = owner.extraApiKeys[0];
    rival = await createApp({
      companyId: `co_mkt_rival_${RUN}`,
      scopes: ['brain:read', 'brain:admin', 'registry:publish'],
    });

    // The paid pack is signed by a publisher this instance trusts →
    // verified=true (feeds the profile ownership rule); the free pack is
    // a plain unsigned publish by the same owner.
    const paidManifest: DomainPackManifest = {
      ...REAL_ESTATE_PACK,
      id: PAID_ID,
      description: 'Marketplace e2e paid pack.',
      publisher: PUBLISHER,
    };
    paidManifest.signature = signPack(paidManifest, trusted.priv);
    for (const manifest of [
      paidManifest,
      { ...REAL_ESTATE_PACK, id: FREE_ID, description: 'Marketplace e2e free pack.' },
    ]) {
      const r = await owner.http
        .post('/v1/admin/registry/packs')
        .set(auth(owner))
        .send({ manifest });
      expect([200, 201]).toContain(r.status);
    }
  });

  afterAll(async () => {
    delete process.env.DOMAIN_PACK_BILLING_ENABLED;
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    delete process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS;
    delete process.env.DOMAIN_PACK_TRUSTED_KEYS;
    if (owner) await owner.close();
    if (rival) await rival.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const downloadsOf = async (packId: string): Promise<number> => {
    const r = await owner.http
      .get(`/v1/registry/packs/${packId}`)
      .set(auth(owner));
    return r.body.versions[0].downloads as number;
  };

  describe('pricing (publisher-owned)', () => {
    it('403s pricing by a company that did not publish the pack', async () => {
      const r = await rival.http
        .put(`/v1/admin/registry/packs/${PAID_ID}/pricing`)
        .set(auth(rival))
        .send({ amount: 999, currency: 'USD' });
      expect(r.status).toBe(403);
    });

    it('404s pricing an unknown pack', async () => {
      const r = await owner.http
        .put(`/v1/admin/registry/packs/no_such_pack_${RUN}/pricing`)
        .set(auth(owner))
        .send({ amount: 999, currency: 'USD' });
      expect(r.status).toBe(404);
    });

    it('rejects a malformed price body', async () => {
      for (const body of [
        { amount: 0, currency: 'USD' },
        { amount: 12.5, currency: 'USD' },
        { amount: 999, currency: 'DOLLARS' },
        {},
      ]) {
        const r = await owner.http
          .put(`/v1/admin/registry/packs/${PAID_ID}/pricing`)
          .set(auth(owner))
          .send(body);
        expect(r.status).toBe(400);
      }
    });

    it('prices the pack: billing product + fresh price + registry meta', async () => {
      const r = await owner.http
        .put(`/v1/admin/registry/packs/${PAID_ID}/pricing`)
        .set(auth(owner))
        .send({ amount: 2900, currency: 'usd' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        packId: PAID_ID,
        paid: true,
        displayPrice: { amount: 2900, currency: 'USD' },
      });
      expect(r.body.priceCode).toMatch(new RegExp(`^pack_${PAID_ID}_\\d+$`));
      // The stub recorded the product with the entitlement metadata.
      const product = billing.products.find(
        (p) => p.code === `pack_${PAID_ID}`,
      );
      expect(product).toBeDefined();
      expect(product!.metadata).toEqual({
        entitlements: [`domain_pack:${PAID_ID}`],
      });
    });

    it('lists the pack as paid with its display price (free pack untouched)', async () => {
      const paidList = await owner.http
        .get(`/v1/registry/packs?q=${PAID_ID}`)
        .set(auth(owner));
      const paid = paidList.body.packs.find((p: any) => p.packId === PAID_ID);
      expect(paid.paid).toBe(true);
      expect(paid.displayPrice).toEqual({ amount: 2900, currency: 'USD' });

      const freeList = await owner.http
        .get(`/v1/registry/packs?q=${FREE_ID}`)
        .set(auth(owner));
      const free = freeList.body.packs.find((p: any) => p.packId === FREE_ID);
      expect('paid' in free).toBe(false);
      expect('displayPrice' in free).toBe(false);
    });
  });

  describe('purchase flow (402 → checkout → entitlement → install)', () => {
    it('402s the install with a self-describing hint — and does not count a download', async () => {
      const r = await owner.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(owner))
        .send({ packId: PAID_ID });
      expect(r.status).toBe(402);
      expect(r.body).toMatchObject({
        statusCode: 402,
        error: 'Payment Required',
        packId: PAID_ID,
        displayPrice: { amount: 2900, currency: 'USD' },
        checkout: {
          method: 'POST',
          path: `/v1/admin/registry/packs/${PAID_ID}/checkout`,
        },
      });
      expect(await downloadsOf(PAID_ID)).toBe(0);
    });

    it('creates a checkout session (userId = companyId, idempotency-key forwarded)', async () => {
      const r = await owner.http
        .post(`/v1/admin/registry/packs/${PAID_ID}/checkout`)
        .set(auth(owner))
        .set('idempotency-key', `idem_${RUN}`)
        .send({ successUrl: 'https://app.example/ok' });
      expect([200, 201]).toContain(r.status);
      expect(typeof r.body.sessionId).toBe('string');
      expect(r.body.checkoutUrl).toContain('https://');
      const call = billing.checkouts.at(-1)!;
      expect(call.headers['idempotency-key']).toBe(`idem_${RUN}`);
      expect(call.body).toMatchObject({
        mode: 'PAYMENT',
        userId: owner.companyId,
        successUrl: 'https://app.example/ok',
        metadata: {
          packId: PAID_ID,
          companyId: owner.companyId,
          source: 'brain_marketplace',
        },
      });
    });

    it('400s checkout for a free pack', async () => {
      const r = await owner.http
        .post(`/v1/admin/registry/packs/${FREE_ID}/checkout`)
        .set(auth(owner))
        .send({});
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/free/i);
    });

    it('installs once the entitlement is granted — downloads +1 exactly once', async () => {
      billing.entitlements[owner.companyId] = [
        { key: `domain_pack:${PAID_ID}` },
      ];
      const r = await owner.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(owner))
        .send({ packId: PAID_ID });
      expect([200, 201]).toContain(r.status);
      expect(r.body.packId).toBe(PAID_ID);
      // Exactly the ONE successful install counted — not the earlier 402.
      expect(await downloadsOf(PAID_ID)).toBe(1);
    });

    it('still 402s the OTHER company (entitlements are per companyId)', async () => {
      const r = await rival.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(rival))
        .send({ packId: PAID_ID });
      expect(r.status).toBe(402);
    });
  });

  describe('billing outage (fail-closed)', () => {
    afterEach(() => {
      billing.failAll = false;
    });

    it('503s a paid install while billing is down; free packs still install', async () => {
      billing.failAll = true;
      const paid = await rival.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(rival))
        .send({ packId: PAID_ID });
      expect(paid.status).toBe(503);

      const free = await owner.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(owner))
        .send({ packId: FREE_ID });
      expect([200, 201]).toContain(free.status);
    });
  });

  describe('un-pricing', () => {
    it('403s the clear for a non-owner, then clears for the owner → free install', async () => {
      const denied = await rival.http
        .delete(`/v1/admin/registry/packs/${PAID_ID}/pricing`)
        .set(auth(rival));
      expect(denied.status).toBe(403);

      const cleared = await owner.http
        .delete(`/v1/admin/registry/packs/${PAID_ID}/pricing`)
        .set(auth(owner));
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ packId: PAID_ID, paid: false });

      // No entitlement needed anymore — the rival installs free.
      const r = await rival.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(rival))
        .send({ packId: PAID_ID });
      expect([200, 201]).toContain(r.status);
    });
  });

  describe('featured curation (registry:curate)', () => {
    it('403s feature with a publish-only key', async () => {
      const r = await owner.http
        .post(`/v1/admin/registry/packs/${PAID_ID}/feature`)
        .set(auth(owner)); // owner main key: registry:publish, NO curate
      expect(r.status).toBe(403);
    });

    it('404s featuring an unknown pack', async () => {
      const r = await owner.http
        .post(`/v1/admin/registry/packs/no_such_pack_${RUN}/feature`)
        .set({ Authorization: `Bearer ${curateKey}` });
      expect(r.status).toBe(404);
    });

    it('features with the curate key — listing + public UI surface it', async () => {
      const r = await owner.http
        .post(`/v1/admin/registry/packs/${PAID_ID}/feature`)
        .set({ Authorization: `Bearer ${curateKey}` });
      expect([200, 201]).toContain(r.status);
      expect(r.body).toEqual({ packId: PAID_ID, featured: true });

      const list = await owner.http
        .get(`/v1/registry/packs?q=${PAID_ID}`)
        .set(auth(owner));
      const summary = list.body.packs.find((p: any) => p.packId === PAID_ID);
      expect(summary.featured).toBe(true);
      expect(new Date(summary.featuredAt).getTime()).not.toBeNaN();

      const ui = await owner.http.get('/registry/ui'); // public, no auth
      expect(ui.status).toBe(200);
      expect(ui.text).toContain('class="featured-sec"');
      expect(ui.text).toContain(PAID_ID);

      const off = await owner.http
        .post(`/v1/admin/registry/packs/${PAID_ID}/unfeature`)
        .set({ Authorization: `Bearer ${curateKey}` });
      expect(off.body).toEqual({ packId: PAID_ID, featured: false });
      const after = await owner.http
        .get(`/v1/registry/packs?q=${PAID_ID}`)
        .set(auth(owner));
      expect(
        'featured' in after.body.packs.find((p: any) => p.packId === PAID_ID),
      ).toBe(false);
    });
  });

  describe('publisher profiles (verified-ownership rule)', () => {
    it('403s the profile write for a company without a verified pack under the publisher', async () => {
      const r = await rival.http
        .put(`/v1/admin/registry/publishers/${PUBLISHER}`)
        .set(auth(rival))
        .send({ displayName: 'Impostor Inc' });
      expect(r.status).toBe(403);
    });

    it('lets the verified publisher write, then serves JSON + public HTML', async () => {
      const put = await owner.http
        .put(`/v1/admin/registry/publishers/${PUBLISHER}`)
        .set(auth(owner))
        .send({
          displayName: 'Marketplace E2E Publisher',
          url: 'https://acme.example',
          bio: 'We ship verified packs.',
          contactEmail: 'packs@acme.example',
        });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        publisher: PUBLISHER,
        displayName: 'Marketplace E2E Publisher',
        url: 'https://acme.example',
      });

      const json = await owner.http
        .get(`/v1/registry/publishers/${PUBLISHER}`)
        .set(auth(owner));
      expect(json.status).toBe(200);
      expect(json.body.profile.displayName).toBe('Marketplace E2E Publisher');
      expect(
        json.body.packs.some((p: any) => p.packId === PAID_ID),
      ).toBe(true);

      const html = await owner.http.get(
        `/registry/ui/publisher/${PUBLISHER}`,
      ); // public, no auth
      expect(html.status).toBe(200);
      expect(html.text).toContain('Marketplace E2E Publisher');
      expect(html.text).toContain(PAID_ID);
    });

    it('rejects invalid profile bodies', async () => {
      for (const body of [
        { displayName: '' },
        { displayName: 'x'.repeat(121) },
        { displayName: 'ok', url: 'javascript' + ':alert(1)' },
        { displayName: 'ok', contactEmail: 'not-an-email' },
      ]) {
        const r = await owner.http
          .put(`/v1/admin/registry/publishers/${PUBLISHER}`)
          .set(auth(owner))
          .send(body);
        expect(r.status).toBe(400);
      }
    });

    it('404s an unknown publisher on JSON; empty-state page on the public UI', async () => {
      const json = await owner.http
        .get(`/v1/registry/publishers/ghost_${RUN}`)
        .set(auth(owner));
      expect(json.status).toBe(404);

      const html = await owner.http.get(`/registry/ui/publisher/ghost_${RUN}`);
      expect(html.status).toBe(200);
      expect(html.text).toContain('No packs from this publisher');
    });
  });
});
