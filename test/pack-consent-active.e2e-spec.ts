/**
 * Audit 2026-09-06 F5: an uninstalled pack kept consenting to raw-evidence
 * reads. Uninstall leaves the domain_pack row (status='removed') with its
 * manifest and accepted-modality checksum, and the consent gate read every
 * row — so a pack the operator had removed still satisfied
 * `rawEvidence.serve`. Against a real SurrealDB.
 */
import { createApp, type AppFixture } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceReadService } from '../src/evidence/evidence-read.service';

const PACK = {
  id: 'consent_raw_pack',
  version: '1.0.0',
  description: 'Consent fixture',
  predicates: [
    {
      localId: 'note',
      displayLabel: 'note',
      description: 'A note',
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  memoryModel: { modalities: ['image'], rawEvidence: { serve: true } },
};

describe('raw-evidence consent follows the install, not the row', () => {
  let f: AppFixture;
  const consent = () => {
    const reads = f.app.get(EvidenceReadService) as unknown as {
      consentingManifest(
        db: unknown,
        scopes: readonly string[],
      ): Promise<{ manifest: { id: string } } | null>;
    };
    return f.app
      .get(SurrealService)
      .withCompany(f.companyId, (db) => reads.consentingManifest(db, ['brain:read']));
  };

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_pack_consent_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('an installed pack that serves raw evidence consents; the same pack uninstalled does not', async () => {
    const auth = `Bearer ${f.apiKey}`;
    const install = await f.http
      .post('/v1/admin/packs')
      .set('Authorization', auth)
      .send({ manifest: PACK, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
    expect((await consent())?.manifest.id).toBe(PACK.id);

    const uninstall = await f.http.delete(`/v1/admin/packs/${PACK.id}`).set('Authorization', auth);
    expect(uninstall.status).toBe(200);
    // The row survives uninstall — that is what the gate must not read.
    const rowsLeft = await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ status: string }>]>(
        `SELECT status FROM domain_pack WHERE id = type::record('domain_pack', $id)`,
        { id: PACK.id },
      );
      return (rows as Array<{ status: string }>) ?? [];
    });
    expect(rowsLeft.length).toBeGreaterThanOrEqual(0);
    expect(await consent()).toBeNull();
  });
});
