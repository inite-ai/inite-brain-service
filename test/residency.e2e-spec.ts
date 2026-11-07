/**
 * #916 step 3 on a real SurrealDB: a tenant pinned to another region is
 * refused (421) and nothing is created for it; a tenant with data here
 * cannot be pinned elsewhere (409); a regional cell serves only tenants
 * pinned to it.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('data residency (0191)', () => {
  const saved = {
    region: process.env.BRAIN_REGION,
    override: process.env.BRAIN_TENANT_OVERRIDE_ENABLED,
  };
  afterAll(() => {
    for (const [k, v] of [
      ['BRAIN_REGION', saved.region],
      ['BRAIN_TENANT_OVERRIDE_ENABLED', saved.override],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('the default deployment', () => {
    let f: AppFixture;
    const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
    beforeAll(async () => {
      delete process.env.BRAIN_REGION;
      process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
      f = await createApp({
        companyId: `co_resdef_${Date.now()}`,
        scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:platform_admin'],
      });
    });
    afterAll(async () => {
      if (f) await f.close();
    });

    it('a tenant pinned to another region is refused with 421 and never created here', async () => {
      const other = `ru_tenant_${Date.now()}`;
      const pin = await f.http
        .put(`/v1/admin/residency/${other}`)
        .set(auth())
        .send({ region: 'ru' });
      expect(pin.status).toBe(200);
      expect(pin.body).toMatchObject({ region: 'ru', deploymentRegion: 'default' });
      const surreal = f.app.get(SurrealService);
      await expect(surreal.withCompany(other, async () => 1)).rejects.toMatchObject({
        status: 421,
        region: 'ru',
      });
      const exists = await surreal.withAdminDb(async (db) => {
        const [info] = await db.query<[{ databases?: Record<string, unknown> }]>(`INFO FOR NS`);
        return `co_${other}` in (info?.databases ?? {});
      });
      expect(exists).toBe(false);
    });

    it('a tenant with data here cannot be pinned to another region (409)', async () => {
      await f.app.get(SurrealService).withCompany(f.companyId, async () => 1);
      const r = await f.http
        .put(`/v1/admin/residency/${f.companyId}`)
        .set(auth())
        .send({ region: 'ru' });
      expect(r.status).toBe(409);
    });
  });

  describe('a regional cell', () => {
    let f: AppFixture;
    const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
    beforeAll(async () => {
      process.env.BRAIN_REGION = 'ru';
      process.env.BRAIN_TENANT_OVERRIDE_ENABLED = '1';
      f = await createApp({
        companyId: `co_rescell_${Date.now()}`,
        scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:platform_admin'],
      });
    });
    afterAll(async () => {
      if (f) await f.close();
    });

    it('serves only tenants pinned to it — first pinned by the ops path, then by REST', async () => {
      const surreal = f.app.get(SurrealService);
      await expect(surreal.withCompany(f.companyId, async () => 1)).rejects.toMatchObject({
        status: 421,
      });
      // A fresh cell serves no one, so no key can authenticate through a
      // tenant here yet: the first pin is the ops path (residency:pin).
      await surreal.residency.pin(f.companyId, 'ru', 'ops:test');
      await expect(surreal.withCompany(f.companyId, async () => 1)).resolves.toBe(1);
      const other = `ru_more_${Date.now()}`;
      const pin = await f.http
        .put(`/v1/admin/residency/${other}`)
        .set(auth())
        .send({ region: 'ru' });
      expect(pin.status).toBe(200);
      await expect(surreal.withCompany(other, async () => 1)).resolves.toBe(1);
    });
  });
});
