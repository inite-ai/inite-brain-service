/**
 * Global Domain Pack registry — end-to-end on a real DB.
 *
 * Proves the full product loop: publish → discover → install-from-registry, plus
 * the supply-chain invariants (version immutability, idempotent republish, yank
 * excludes from latest + blocks pinned install, unyank restores) and scope
 * enforcement (registry:publish for writes, brain:read for discovery). The
 * catalogue lives in the shared `system` DB (withAdminDb), distinct from the
 * per-tenant domain_pack install record.
 */
import { REAL_ESTATE_PACK } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

// A distinct pack id per run guards against catalogue rows lingering in the
// shared system DB across spec files in one jest process.
const PACK = {
  ...REAL_ESTATE_PACK,
  id: 'realty_reg_e2e',
  description: 'Registry e2e real-estate pack.',
};
const bump = (version: string) => ({ ...PACK, version });

describe('/v1/registry — global pack registry (e2e)', () => {
  let pub: AppFixture; // has registry:publish + brain:admin + brain:read
  let reader: AppFixture; // brain:read only
  const auth = (f: AppFixture) => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    pub = await createApp({
      companyId: 'co_registry_pub_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'registry:publish'],
    });
    reader = await createApp({
      companyId: 'co_registry_reader_e2e',
      scopes: ['brain:read'],
    });
  });
  afterAll(async () => {
    if (pub) await pub.close();
    if (reader) await reader.close();
  });

  it('publishes a pack version', async () => {
    const r = await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: bump('0.1.0'), keywords: ['Property', 'real-estate'] });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe(PACK.id);
    expect(r.body.version).toBe('0.1.0');
    expect(r.body.created).toBe(true);
    expect(typeof r.body.checksum).toBe('string');
  });

  it('is idempotent for an identical republish', async () => {
    const r = await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: bump('0.1.0') });
    expect([200, 201]).toContain(r.status);
    expect(r.body.created).toBe(false);
  });

  it('rejects republishing the same version with different content (409)', async () => {
    const r = await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: { ...bump('0.1.0'), description: 'tampered' } });
    expect(r.status).toBe(409);
  });

  it('lets any brain:read tenant discover the catalogue', async () => {
    const list = await reader.http
      .get('/v1/registry/packs?q=realty_reg')
      .set(auth(reader));
    expect(list.status).toBe(200);
    const found = list.body.packs.find((p: any) => p.packId === PACK.id);
    expect(found).toBeDefined();
    expect(found.latestVersion).toBe('0.1.0');
    expect(found.keywords).toContain('real-estate'); // normalized lowercase

    const versions = await reader.http
      .get(`/v1/registry/packs/${PACK.id}`)
      .set(auth(reader));
    expect(versions.body.latestVersion).toBe('0.1.0');
    expect(versions.body.versions.map((v: any) => v.version)).toContain('0.1.0');

    const manifest = await reader.http
      .get(`/v1/registry/packs/${PACK.id}/latest`)
      .set(auth(reader));
    expect(manifest.body.manifest.id).toBe(PACK.id);
    expect(manifest.body.version).toBe('0.1.0');
  });

  it('denies publish without registry:publish (403)', async () => {
    const r = await reader.http
      .post('/v1/admin/registry/packs')
      .set(auth(reader))
      .send({ manifest: bump('9.9.9') });
    expect(r.status).toBe(403);
  });

  it('installs a pack from the registry into a tenant', async () => {
    const r = await pub.http
      .post('/v1/admin/packs/from-registry')
      .set(auth(pub))
      .send({ packId: PACK.id });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe(PACK.id);
    expect(r.body.predicatesSeeded).toBe(PACK.predicates.length);

    const installed = await pub.http.get('/v1/admin/packs').set(auth(pub));
    expect(
      installed.body.installed.some((p: any) => p.packId === PACK.id),
    ).toBe(true);
  });

  it('resolves latest across versions and yank flips it back', async () => {
    // Publish a newer version → latest advances.
    await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: bump('0.2.0') });
    let versions = await reader.http
      .get(`/v1/registry/packs/${PACK.id}`)
      .set(auth(reader));
    expect(versions.body.latestVersion).toBe('0.2.0');

    // Yank it → latest falls back to 0.1.0.
    const yank = await pub.http
      .post(`/v1/admin/registry/packs/${PACK.id}/0.2.0/yank`)
      .set(auth(pub))
      .send({ reason: 'bad release' });
    expect([200, 201]).toContain(yank.status);
    expect(yank.body.yanked).toBe(true);

    versions = await reader.http
      .get(`/v1/registry/packs/${PACK.id}`)
      .set(auth(reader));
    expect(versions.body.latestVersion).toBe('0.1.0');

    // Installing the yanked version explicitly is refused.
    const pinned = await pub.http
      .post('/v1/admin/packs/from-registry')
      .set(auth(pub))
      .send({ packId: PACK.id, version: '0.2.0' });
    expect(pinned.status).toBe(400);

    // Unyank restores it as latest.
    const unyank = await pub.http
      .post(`/v1/admin/registry/packs/${PACK.id}/0.2.0/unyank`)
      .set(auth(pub));
    expect([200, 201]).toContain(unyank.status);
    versions = await reader.http
      .get(`/v1/registry/packs/${PACK.id}`)
      .set(auth(reader));
    expect(versions.body.latestVersion).toBe('0.2.0');
  });

  it('404s installing a pack that is not in the registry', async () => {
    const r = await pub.http
      .post('/v1/admin/packs/from-registry')
      .set(auth(pub))
      .send({ packId: 'no_such_pack_xyz' });
    expect(r.status).toBe(404);
  });

  it('rejects publishing a builtin pack id (namespace squatting)', async () => {
    const r = await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: { ...bump('1.0.0'), id: 'code_memory' } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/reserved|builtin/i);
  });

  it('does not 500 on a non-array keywords body (coerces to empty)', async () => {
    const r = await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({
        manifest: { ...PACK, id: 'kw_guard_e2e', version: '0.1.0' },
        keywords: 'not-an-array',
      });
    expect([200, 201]).toContain(r.status);
    const versions = await reader.http
      .get('/v1/registry/packs/kw_guard_e2e')
      .set(auth(reader));
    expect(versions.body.versions[0].keywords).toEqual([]);
  });

  it('paginates the catalogue with offset (packs beyond a page stay reachable)', async () => {
    // Two distinct packs → page size 1 must surface each via offset.
    for (const id of ['pg_a_e2e', 'pg_b_e2e']) {
      await pub.http
        .post('/v1/admin/registry/packs')
        .set(auth(pub))
        .send({ manifest: { ...PACK, id, version: '0.1.0' } });
    }
    const page1 = await reader.http
      .get('/v1/registry/packs?q=pg_&limit=1&offset=0')
      .set(auth(reader));
    const page2 = await reader.http
      .get('/v1/registry/packs?q=pg_&limit=1&offset=1')
      .set(auth(reader));
    expect(page1.body.packs).toHaveLength(1);
    expect(page2.body.packs).toHaveLength(1);
    // Sorted by packId → distinct, non-overlapping pages.
    expect(page1.body.packs[0].packId).not.toBe(page2.body.packs[0].packId);
    const seen = [page1.body.packs[0].packId, page2.body.packs[0].packId].sort();
    expect(seen).toEqual(['pg_a_e2e', 'pg_b_e2e']);
  });
});
