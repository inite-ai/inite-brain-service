/**
 * Modality consent tier (0112) — lean install-flow e2e: a manifest that
 * declares non-text modalities (via the defensive accessor's documented
 * shape, `memoryModel.modalities` + `memoryModel.rawEvidence`) is
 * rejected without acceptModalities, installs with it, carries consent
 * over on a byte-identical re-install, and re-requires the flag when the
 * media section changes. A modality-free manifest stays byte-identical
 * to the pre-0112 path (inert by construction).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('pack modality consent (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const predicate = {
    localId: 'media_note',
    displayLabel: 'media note',
    description: 'TYPE subject is a person; value is a note about a media item',
    datatype: 'string',
    semantics: 'append_only',
    decayHalfLifeDays: null,
    piiClass: 'none',
    status: 'active',
  };

  const manifest = (over: Record<string, unknown> = {}) => ({
    id: 'media_modality',
    version: '1.0.0',
    description: 'Modality consent test pack (e2e).',
    predicates: [predicate],
    // The defensive accessor's documented probe shape — see
    // src/ai/domain-packs/modality-consent.ts declaredModalitySection().
    memoryModel: { modalities: ['text', 'image'], rawEvidence: { serve: true } },
    ...over,
  });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_pack_modality_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
    });
  }, 120_000);

  afterAll(async () => {
    if (f) await f.close();
  });

  it('rejects a modality-declaring manifest without acceptModalities (naming the modalities)', async () => {
    const r = await f.http.post('/v1/admin/packs').set(auth()).send({ manifest: manifest() });
    expect(r.status).toBe(400);
    const msg = JSON.stringify(r.body);
    expect(msg).toContain('acceptModalities');
    expect(msg).toContain('image');
    expect(msg).toContain('raw-evidence');
  });

  it('installs with acceptModalities: true', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest(), acceptModalities: true });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe('media_modality');
  });

  it('carries consent over on an upgrade with an identical media section', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest({ version: '1.0.1' }) });
    expect([200, 201]).toContain(r.status);
  });

  it('re-requires the flag when the media section changes, then accepts it', async () => {
    const changed = manifest({
      version: '1.1.0',
      memoryModel: { modalities: ['text', 'image', 'audio'], rawEvidence: { serve: true } },
    });
    const denied = await f.http.post('/v1/admin/packs').set(auth()).send({ manifest: changed });
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain('acceptModalities');

    const ok = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: changed, acceptModalities: true });
    expect([200, 201]).toContain(ok.status);
  });

  it('a modality-free manifest installs without the flag (inert path)', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({
        manifest: {
          id: 'media_plain',
          version: '1.0.0',
          description: 'Modality-free control pack (e2e).',
          predicates: [predicate],
        },
      });
    expect([200, 201]).toContain(r.status);
  });
});
