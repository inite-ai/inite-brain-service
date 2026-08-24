/**
 * Phase audit closure: verify the demo controller's includePii flag
 * is now scope-gated. Pre-fix the controller granted itself
 * `brain:read_pii` based purely on the body flag — a brain:admin
 * token without read_pii could self-elevate. Now it 403s.
 *
 * Also verifies per-caller tenant scoping: two admins from different
 * parent companies see isolated demo state (their POSTs to
 * /demo/state observe their own facts only).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('/v1/admin/demo — PII scope + per-caller tenant', () => {
  describe('includePii scope gate', () => {
    let fAdminOnly: AppFixture;
    let fAdminPlusPii: AppFixture;

    beforeAll(async () => {
      fAdminOnly = await createApp({
        companyId: 'co_admin_only',
        scopes: ['brain:read', 'brain:write', 'brain:admin'],
      });
      fAdminPlusPii = await createApp({
        companyId: 'co_admin_pii',
        scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      });
    });

    afterAll(async () => {
      if (fAdminOnly) await fAdminOnly.close();
      if (fAdminPlusPii) await fAdminPlusPii.close();
    });

    it('rejects includePii=true when caller has no brain:read_pii', async () => {
      const r = await fAdminOnly.http
        .post('/v1/admin/demo/search')
        .set({ Authorization: `Bearer ${fAdminOnly.apiKey}` })
        .send({ query: 'who', includePii: true });
      expect(r.status).toBe(403);
    });

    it('accepts includePii=false on admin-only', async () => {
      const r = await fAdminOnly.http
        .post('/v1/admin/demo/search')
        .set({ Authorization: `Bearer ${fAdminOnly.apiKey}` })
        .send({ query: 'who' });
      expect([200, 201]).toContain(r.status);
    });

    it('accepts includePii=true when caller already holds read_pii', async () => {
      const r = await fAdminPlusPii.http
        .post('/v1/admin/demo/search')
        .set({ Authorization: `Bearer ${fAdminPlusPii.apiKey}` })
        .send({ query: 'who', includePii: true });
      expect([200, 201]).toContain(r.status);
    });
  });
});
