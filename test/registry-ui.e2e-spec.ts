/**
 * Registry UI — end-to-end. A published pack shows up on the public,
 * unauthenticated HTML catalogue page, with its download count and the
 * verified-publisher badge.
 */
import { generateKeyPairSync } from 'node:crypto';
import { REAL_ESTATE_PACK, signPack, type DomainPackManifest } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('GET /registry/ui — public catalogue (e2e)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    process.env.DOMAIN_PACK_TRUSTED_KEYS = JSON.stringify({
      ui_pub_e2e: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    f = await createApp({
      companyId: 'co_registry_ui_e2e',
      scopes: ['brain:read', 'brain:admin', 'registry:publish'],
    });
    const auth = { Authorization: `Bearer ${f.apiKey}` };
    // A signed pack whose publisher this instance trusts → verified badge.
    const manifest: DomainPackManifest = {
      ...REAL_ESTATE_PACK,
      id: 'realty_ui_e2e',
      publisher: 'ui_pub_e2e',
    };
    manifest.signature = signPack(
      manifest,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    await f.http.post('/v1/admin/registry/packs').set(auth).send({ manifest });
    // One install-from-registry → download counter at 1.
    await f.http.post('/v1/admin/packs/from-registry').set(auth).send({ packId: 'realty_ui_e2e' });
  });
  afterAll(async () => {
    delete process.env.DOMAIN_PACK_TRUSTED_KEYS;
    if (f) await f.close();
  });

  it('serves an HTML page listing the published pack — no auth required', async () => {
    const r = await f.http.get('/registry/ui'); // deliberately no Authorization
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('realty_ui_e2e');
    expect(r.text).toContain('Domain Pack registry');
  });

  it('renders the verified badge, download count, and published date', async () => {
    const r = await f.http.get('/registry/ui');
    expect(r.status).toBe(200);
    expect(r.text).toContain('badge verified');
    expect(r.text).toContain('1 download(s)');
    expect(r.text).toMatch(/published \d{4}-\d{2}-\d{2}/);
  });
});
