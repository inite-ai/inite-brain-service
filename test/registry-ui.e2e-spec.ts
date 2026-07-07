/**
 * Registry UI — end-to-end. A published pack shows up on the public,
 * unauthenticated HTML catalogue page.
 */
import { REAL_ESTATE_PACK } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('GET /registry/ui — public catalogue (e2e)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_registry_ui_e2e',
      scopes: ['brain:read', 'registry:publish'],
    });
    await f.http
      .post('/v1/admin/registry/packs')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ manifest: { ...REAL_ESTATE_PACK, id: 'realty_ui_e2e' } });
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('serves an HTML page listing the published pack — no auth required', async () => {
    const r = await f.http.get('/registry/ui'); // deliberately no Authorization
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('realty_ui_e2e');
    expect(r.text).toContain('Domain Pack registry');
  });
});
