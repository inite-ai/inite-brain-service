/**
 * F9 (audit 2026-09-06) against a REAL SurrealDB: a suspended tenant whose
 * credential is still valid keeps authenticating, and every request used to
 * put it straight back into the synchronous active roster (touch() added
 * to the cache before anything else) until the next refresh dropped it —
 * a suspended tenant in and out of background fan-out by the minute.
 *
 * Membership now follows the registry STATUS, never the activity: the
 * tenant stays out synchronously, after its lastSeen write, and across a
 * roster refresh; lastSeen is still recorded.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { TenantRegistryService } from '../src/auth/tenant-registry.service';
import { ApiKeyService } from '../src/auth/api-key.service';

describe('tenant registry: suspension survives activity (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const settle = () => new Promise((r) => setTimeout(r, 250));

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_suspended_roster_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const registry = () => f.app.get(TenantRegistryService);

  const rowFor = async (companyId: string) => {
    const surreal = f.app.get(SurrealService);
    return surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ status: string; lastSeen: unknown }>]>(
        `SELECT status, lastSeen FROM type::record('tenant_registry', $id)`,
        { id: companyId },
      );
      return (rows as Array<{ status: string; lastSeen: unknown }>)?.[0];
    });
  };

  it('an active tenant enters the roster through the credential path', async () => {
    await registry().register(f.companyId, { status: 'active' });
    const r = await f.http.get('/v1/facts/knowledge_fact:nope').set(auth());
    expect(r.status).not.toBe(401);
    await settle();
    expect(registry().activeCompanyIds()).toContain(f.companyId);
    expect(f.app.get(ApiKeyService).knownCompanyIds()).toContain(f.companyId);
  });

  it('a suspended tenant with a valid credential stays OUT of the roster, even transiently', async () => {
    await registry().register(f.companyId, { status: 'suspended' });
    expect(registry().activeCompanyIds()).not.toContain(f.companyId);
    const before = await rowFor(f.companyId);

    // The real hot path: an authenticated request resolves the tenant and
    // the credential resolver calls touch() on it.
    const r = await f.http.get('/v1/facts/knowledge_fact:nope').set(auth());
    expect(r.status).not.toBe(401);
    // Synchronously — the old code added the tenant right here.
    expect(registry().activeCompanyIds()).not.toContain(f.companyId);
    await settle();
    // After the lastSeen write echoed the row's status back.
    expect(registry().activeCompanyIds()).not.toContain(f.companyId);

    // The status was not touched. (register() wrote lastSeen a moment ago,
    // so this touch is inside the write throttle — the lastSeen write path
    // for a tenant unknown to this pod is exercised by the next test.)
    const after = await rowFor(f.companyId);
    expect(after?.status).toBe('suspended');
    expect(after?.lastSeen).toBeDefined();
    expect(before?.status).toBe('suspended');

    // And across a roster refresh from the registry (what other pods do).
    await (registry() as unknown as { refresh(): Promise<void> }).refresh();
    expect(registry().activeCompanyIds()).not.toContain(f.companyId);
    expect(await registry().listActive()).not.toContain(f.companyId);
  });

  it('a tenant unknown to this pod but suspended in the registry is not admitted by touch()', async () => {
    const other = 'co_suspended_elsewhere_e2e';
    // Written as another pod would: straight into the registry, so THIS
    // pod's cache has never heard of it.
    const surreal = f.app.get(SurrealService);
    await surreal.withAdminDb(async (db) => {
      await db.query(
        `UPSERT type::record('tenant_registry', $id) SET
           companyId = $id, status = 'suspended', lastSeen = time::now(), updatedAt = time::now()`,
        { id: other },
      );
    });
    registry().touch(other);
    expect(registry().activeCompanyIds()).not.toContain(other);
    await settle();
    expect(registry().activeCompanyIds()).not.toContain(other);
    expect((await rowFor(other))?.status).toBe('suspended');
  });

  it('re-registering as active restores membership', async () => {
    await registry().register(f.companyId, { status: 'active' });
    expect(registry().activeCompanyIds()).toContain(f.companyId);
    await (registry() as unknown as { refresh(): Promise<void> }).refresh();
    expect(registry().activeCompanyIds()).toContain(f.companyId);
  });
});
