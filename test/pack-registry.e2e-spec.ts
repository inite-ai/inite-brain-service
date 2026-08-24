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
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { packChecksum, REAL_ESTATE_PACK, signPack } from '../src/ai/domain-packs';
import { RegistryMirrorService } from '../src/registry/registry-mirror.service';
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

// ed25519 keypairs for the verified-publisher tests: one whose public key the
// hosting instance trusts (DOMAIN_PACK_TRUSTED_KEYS), one rogue.
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
const trusted = keypair();
const rogue = keypair();

describe('/v1/registry — global pack registry (e2e)', () => {
  let pub: AppFixture; // has registry:publish + brain:admin + brain:read
  let reader: AppFixture; // brain:read only
  const auth = (f: AppFixture) => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    // The hosting instance's trust store — read lazily at publish time; set
    // before boot so env validation sees valid JSON too.
    process.env.DOMAIN_PACK_TRUSTED_KEYS = JSON.stringify({
      acme_e2e: trusted.pub,
    });
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
    delete process.env.DOMAIN_PACK_TRUSTED_KEYS;
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
    const list = await reader.http.get('/v1/registry/packs?q=realty_reg').set(auth(reader));
    expect(list.status).toBe(200);
    const found = list.body.packs.find((p: any) => p.packId === PACK.id);
    expect(found).toBeDefined();
    expect(found.latestVersion).toBe('0.1.0');
    expect(found.keywords).toContain('real-estate'); // normalized lowercase

    const versions = await reader.http.get(`/v1/registry/packs/${PACK.id}`).set(auth(reader));
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
    expect(installed.body.installed.some((p: any) => p.packId === PACK.id)).toBe(true);
  });

  it('resolves latest across versions and yank flips it back', async () => {
    // Publish a newer version → latest advances.
    await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: bump('0.2.0') });
    let versions = await reader.http.get(`/v1/registry/packs/${PACK.id}`).set(auth(reader));
    expect(versions.body.latestVersion).toBe('0.2.0');

    // Yank it → latest falls back to 0.1.0.
    const yank = await pub.http
      .post(`/v1/admin/registry/packs/${PACK.id}/0.2.0/yank`)
      .set(auth(pub))
      .send({ reason: 'bad release' });
    expect([200, 201]).toContain(yank.status);
    expect(yank.body.yanked).toBe(true);

    versions = await reader.http.get(`/v1/registry/packs/${PACK.id}`).set(auth(reader));
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
    versions = await reader.http.get(`/v1/registry/packs/${PACK.id}`).set(auth(reader));
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
    const versions = await reader.http.get('/v1/registry/packs/kw_guard_e2e').set(auth(reader));
    expect(versions.body.versions[0].keywords).toEqual([]);
  });

  it('counts downloads on install only — browsing does not count', async () => {
    const id = 'dl_count_e2e';
    await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: { ...PACK, id, version: '0.1.0' } });

    // Hit every read/browse surface: catalogue list, version list, manifest
    // inspection. None of these are installs.
    await reader.http.get('/v1/registry/packs?q=dl_count').set(auth(reader));
    await reader.http.get(`/v1/registry/packs/${id}`).set(auth(reader));
    await reader.http.get(`/v1/registry/packs/${id}/latest`).set(auth(reader));

    let versions = await reader.http.get(`/v1/registry/packs/${id}`).set(auth(reader));
    expect(versions.body.versions[0].downloads).toBe(0);

    // Install from the registry twice (same-version reinstall is an upsert) —
    // each resolve-for-install counts.
    for (let i = 0; i < 2; i++) {
      const r = await pub.http
        .post('/v1/admin/packs/from-registry')
        .set(auth(pub))
        .send({ packId: id });
      expect([200, 201]).toContain(r.status);
    }
    versions = await reader.http.get(`/v1/registry/packs/${id}`).set(auth(reader));
    expect(versions.body.versions[0].downloads).toBe(2);
  });

  it('catalogue summary sums downloads across versions; publishedAt exposed', async () => {
    const id = 'dl_count_e2e'; // 0.1.0 already has 2 downloads from above
    await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: { ...PACK, id, version: '0.2.0' } });
    const r = await pub.http
      .post('/v1/admin/packs/from-registry')
      .set(auth(pub))
      .send({ packId: id, version: '0.2.0' });
    expect([200, 201]).toContain(r.status);

    const list = await reader.http.get('/v1/registry/packs?q=dl_count').set(auth(reader));
    const summary = list.body.packs.find((p: any) => p.packId === id);
    expect(summary.downloads).toBe(3); // 2 (v0.1.0) + 1 (v0.2.0)
    expect(typeof summary.publishedAt).toBe('string');
    expect(new Date(summary.publishedAt).getTime()).not.toBeNaN();

    // Per-version split stays visible on the versions endpoint.
    const versions = await reader.http.get(`/v1/registry/packs/${id}`).set(auth(reader));
    const byVer = Object.fromEntries(
      versions.body.versions.map((v: any) => [v.version, v.downloads]),
    );
    expect(byVer['0.1.0']).toBe(2);
    expect(byVer['0.2.0']).toBe(1);
  });

  it('a refused install (yanked pin) does not count as a download', async () => {
    const id = 'dl_count_e2e';
    await pub.http
      .post('/v1/admin/registry/packs')
      .set(auth(pub))
      .send({ manifest: { ...PACK, id, version: '0.3.0' } });
    await pub.http
      .post(`/v1/admin/registry/packs/${id}/0.3.0/yank`)
      .set(auth(pub))
      .send({ reason: 'bad' });
    const refused = await pub.http
      .post('/v1/admin/packs/from-registry')
      .set(auth(pub))
      .send({ packId: id, version: '0.3.0' });
    expect(refused.status).toBe(400);

    const versions = await reader.http.get(`/v1/registry/packs/${id}`).set(auth(reader));
    const v = versions.body.versions.find((x: any) => x.version === '0.3.0');
    expect(v.downloads).toBe(0);
  });

  it('marks verified=true only when the signature validates against the trust store', async () => {
    const manifest: any = {
      ...PACK,
      id: 'verified_e2e',
      version: '0.1.0',
      publisher: 'acme_e2e',
    };
    manifest.signature = signPack(manifest, trusted.priv);
    const r = await pub.http.post('/v1/admin/registry/packs').set(auth(pub)).send({ manifest });
    expect([200, 201]).toContain(r.status);

    const versions = await reader.http.get('/v1/registry/packs/verified_e2e').set(auth(reader));
    expect(versions.body.versions[0].signed).toBe(true);
    expect(versions.body.versions[0].verified).toBe(true);

    const list = await reader.http.get('/v1/registry/packs?q=verified_e2e').set(auth(reader));
    expect(list.body.packs.find((p: any) => p.packId === 'verified_e2e').verified).toBe(true);
  });

  it('signed but NOT trust-store-verifiable → verified=false, publish still allowed', async () => {
    // Unknown publisher: signature is valid for its key, but the hosting
    // instance has no key for 'rogue_pub_e2e'.
    const unknown: any = {
      ...PACK,
      id: 'unverified_pub_e2e',
      version: '0.1.0',
      publisher: 'rogue_pub_e2e',
    };
    unknown.signature = signPack(unknown, rogue.priv);
    // Known publisher, WRONG key: the signature fails cryptographic verify.
    const badSig: any = {
      ...PACK,
      id: 'badsig_e2e',
      version: '0.1.0',
      publisher: 'acme_e2e',
    };
    badSig.signature = signPack(badSig, rogue.priv);

    for (const m of [unknown, badSig]) {
      const r = await pub.http
        .post('/v1/admin/registry/packs')
        .set(auth(pub))
        .send({ manifest: m });
      expect([200, 201]).toContain(r.status); // not an error — just unverified
      const versions = await reader.http.get(`/v1/registry/packs/${m.id}`).set(auth(reader));
      expect(versions.body.versions[0].signed).toBe(true);
      expect(versions.body.versions[0].verified).toBe(false);
    }
  });

  it('unsigned publish → verified=false', async () => {
    // PACK 0.1.0 was published unsigned at the top of the suite.
    const versions = await reader.http.get(`/v1/registry/packs/${PACK.id}`).set(auth(reader));
    const v = versions.body.versions.find((x: any) => x.version === '0.1.0');
    expect(v.signed).toBe(false);
    expect(v.verified).toBe(false);
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

  describe('pull-only cross-instance mirroring (REGISTRY_UPSTREAM_URL)', () => {
    // A fake UPSTREAM registry served by a plain node http server. State is
    // mutable so tests can flip yanks between sync runs. JSON round-trip the
    // manifests so checksums are computed over exactly what goes on the wire.
    const wire = (m: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(m)) as Record<string, unknown> & {
        id: string;
        version: string;
      };
    const M_010 = wire({ ...PACK, id: 'mirror_e2e', version: '0.1.0' });
    const M_020 = wire({
      ...PACK,
      id: 'mirror_e2e',
      version: '0.2.0',
      description: 'upstream 0.2.0 — must lose to the local publish',
    });
    const M_BUILTIN = wire({ ...PACK, id: 'code_memory', version: '9.0.0' });
    const upstreamPacks: Record<string, Array<{ manifest: typeof M_010; yanked: boolean }>> = {
      mirror_e2e: [
        { manifest: M_010, yanked: false },
        { manifest: M_020, yanked: false },
      ],
      code_memory: [{ manifest: M_BUILTIN, yanked: false }],
    };
    const seenAuth: Array<string | undefined> = [];
    let server: Server;
    let upstreamBase: string;
    let mirror: RegistryMirrorService;

    beforeAll(async () => {
      server = createServer((req, res) => {
        seenAuth.push(req.headers.authorization);
        const url = new URL(req.url ?? '/', 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean); // v1 registry packs [id] [version]
        const json = (body: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        const versionRow = (packId: string, v: { manifest: typeof M_010; yanked: boolean }) => ({
          packId,
          version: v.manifest.version,
          checksum: packChecksum(v.manifest as never),
          description: '',
          keywords: [],
          publisher: null,
          signed: false,
          verified: false,
          yanked: v.yanked,
          yankReason: v.yanked ? 'upstream says no' : null,
          publishedAt: new Date().toISOString(),
          downloads: 0,
        });
        if (parts.length === 3) {
          return json({
            packs: Object.keys(upstreamPacks).map((packId) => ({
              packId,
              latestVersion: '0.1.0',
              description: '',
              keywords: [],
              publisher: null,
              signed: false,
              verified: false,
              downloads: 0,
              versionCount: upstreamPacks[packId]!.length,
            })),
          });
        }
        const rows = upstreamPacks[parts[3]!];
        if (!rows) {
          res.statusCode = 404;
          return res.end('{}');
        }
        if (parts.length === 4) {
          return json({
            packId: parts[3],
            latestVersion: rows[0]!.manifest.version,
            versions: rows.map((v) => versionRow(parts[3]!, v)),
          });
        }
        const row = rows.find((v) => v.manifest.version === parts[4]);
        if (!row) {
          res.statusCode = 404;
          return res.end('{}');
        }
        return json({
          packId: parts[3],
          version: row.manifest.version,
          checksum: packChecksum(row.manifest as never),
          yanked: row.yanked,
          manifest: row.manifest,
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      upstreamBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.REGISTRY_UPSTREAM_URL = upstreamBase;
      process.env.REGISTRY_UPSTREAM_TOKEN = 'upstream-e2e-token';
      mirror = pub.app.get(RegistryMirrorService);
    });

    afterAll(async () => {
      delete process.env.REGISTRY_UPSTREAM_URL;
      delete process.env.REGISTRY_UPSTREAM_TOKEN;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('imports upstream versions with origin, skips local rows, rejects builtin ids', async () => {
      // A LOCAL publish of mirror_e2e@0.2.0 that must win over the upstream's.
      const local020 = { ...PACK, id: 'mirror_e2e', version: '0.2.0' };
      const published = await pub.http
        .post('/v1/admin/registry/packs')
        .set(auth(pub))
        .send({ manifest: local020 });
      expect([200, 201]).toContain(published.status);

      const summary = await mirror.sync();
      expect(summary.imported).toBe(1); // only 0.1.0 — 0.2.0 exists locally
      expect(summary.skippedExisting).toBeGreaterThanOrEqual(1);
      expect(summary.failures).toBeGreaterThanOrEqual(1); // builtin id rejected

      const versions = await reader.http.get('/v1/registry/packs/mirror_e2e').set(auth(reader));
      const byVer = Object.fromEntries(versions.body.versions.map((v: any) => [v.version, v]));
      // Mirrored row carries the origin marker; the local row carries none —
      // and its content is the LOCAL publish, not the upstream 0.2.0.
      expect(byVer['0.1.0'].origin).toBe(upstreamBase);
      expect(byVer['0.2.0'].origin).toBeUndefined();
      const localManifest = await reader.http
        .get('/v1/registry/packs/mirror_e2e/0.2.0')
        .set(auth(reader));
      expect(localManifest.body.manifest.description).not.toContain('upstream');
      // Builtin-id squatting protection held on the mirror path.
      const builtin = await reader.http.get('/v1/registry/packs/code_memory').set(auth(reader));
      expect(builtin.body.versions).toHaveLength(0);
      // The upstream token was sent on every upstream request.
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((a) => a === 'Bearer upstream-e2e-token')).toBe(true);
    });

    it('re-sync is idempotent and mirrors upstream yanks only onto origin-matching rows', async () => {
      // Upstream yanks BOTH versions; locally only the mirrored 0.1.0 may
      // follow — 0.2.0 is a local publish and must stay installable.
      upstreamPacks.mirror_e2e![0]!.yanked = true;
      upstreamPacks.mirror_e2e![1]!.yanked = true;

      const summary = await mirror.sync();
      expect(summary.imported).toBe(0);
      expect(summary.yanksMirrored).toBe(1);

      const versions = await reader.http.get('/v1/registry/packs/mirror_e2e').set(auth(reader));
      const byVer = Object.fromEntries(versions.body.versions.map((v: any) => [v.version, v]));
      expect(byVer['0.1.0'].yanked).toBe(true);
      expect(byVer['0.1.0'].yankReason).toContain('upstream says no');
      expect(byVer['0.2.0'].yanked).toBe(false);
      expect(versions.body.latestVersion).toBe('0.2.0');

      // Third run: nothing left to do (yank already mirrored).
      const again = await mirror.sync();
      expect(again.imported).toBe(0);
      expect(again.yanksMirrored).toBe(0);
    });
  });
});
