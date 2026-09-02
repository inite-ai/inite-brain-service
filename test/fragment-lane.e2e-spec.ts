/**
 * Fragment retrieval lane + fragment citations e2e (MM-zoom PR2:
 * RETRIEVAL_FRAGMENT_LANE / EVIDENCE_FRAGMENT_CITATIONS) over a real
 * SurrealDB (testcontainer).
 *
 * Substrate: one tenant with a consented media pack (0112 columns set
 * directly — no admin API needed) and three fragments whose derived
 * captions all lexically match the query:
 *   - CLEAN     — tenant-global asset, piiClasses [] on the fragment →
 *                 the only one that may render;
 *   - UNCLASSED — fragment piiClasses NONE → fail-closed, never renders;
 *   - OTHERUSER — asset owned by another user → user-fenced out.
 *
 * Pins:
 *   1. CONTROL (both flags off): the generator prompt carries NO media
 *      section and the response no evidenceCitations — byte-identical
 *      serving with the substrate fully populated;
 *   2. lane ON: the clean caption renders (no id headers), the fenced
 *      fragments never appear, and the verifier sees the SAME lines
 *      (capabilityEvidenceLines parity section);
 *   3. + citations ON: id headers render, the generator's
 *      citedFragmentIds resolve through the rendered-set fence
 *      (hallucinated id dropped) into fragment-arm evidenceCitations;
 *   4. + FOVEA_EVIDENCE_CAPABILITY: a visual-required predicate SERVES
 *      when a visual fragment is cited and abstains
 *      'evidence_capability_unmet' when not — the satisfaction seam;
 *   5. consent STALE ⇒ the lane is empty again (0112 fence).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { SurrealService } from '../src/db/surreal.service';
import {
  declaredModalitySection,
  modalitiesChecksum,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

const FLAG_KEYS = [
  'RETRIEVAL_FRAGMENT_LANE',
  'EVIDENCE_FRAGMENT_CITATIONS',
  'FOVEA_EVIDENCE_CAPABILITY',
] as const;

describe('Fragment lane + fragment citations e2e', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  let factId: string;
  let cleanFragmentId: string;
  let cleanAssetId: string;

  const CLEAN_CAPTION = 'whiteboard photo: the evacuation plan pinned in the ops room';
  const UNCLASSED_CAPTION = 'unclassified snapshot: evacuation plan pinned somewhere';
  const OTHERUSER_CAPTION = 'private photo: evacuation plan pinned at home';
  const QUERY = 'evacuation plan pinned';
  const ANSWER = 'On the ops-room whiteboard.';
  const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });

  const MANIFEST = {
    memoryModel: { modalities: ['text', 'image'] },
  } as unknown as DomainPackManifest;
  const CURRENT_CHECKSUM = modalitiesChecksum(declaredModalitySection(MANIFEST));

  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  beforeAll(async () => {
    for (const k of [...FLAG_KEYS, 'RETRIEVAL_ABSTENTION_CALIBRATION']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Pin abstention off so a thin-evidence query never pre-abstains
    // before generation (the 0113 e2e discipline).
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    f = await createApp({ companyId: 'co_fragment_lane_e2e' });

    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'ops_room' },
        predicate: 'status',
        object: 'the evacuation plan is pinned on the ops-room whiteboard',
        validFrom: new Date('2026-05-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        userId: 'u_frag',
      });
    expect([200, 201]).toContain(r.status);
    factId = r.body.factId as string;
    expect(factId).toBeTruthy();

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      // 0112 consent: a consented media pack (row shaped like the
      // install service writes it; manifest is FLEXIBLE).
      await db.query(
        `CREATE domain_pack CONTENT {
           packId: 'media_pack_e2e', version: '1.0.0',
           manifest: $manifest,
           acceptedModalities: true,
           acceptedModalitiesChecksum: $checksum
         }`,
        { manifest: MANIFEST, checksum: CURRENT_CHECKSUM },
      );
      // CLEAN: tenant-global asset + affirmatively-clean fragment.
      const [cleanAsset] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT {
           modality: 'image', mediaType: 'image/jpeg',
           byteHash: 'e2e-clean-hash', byteLength: 100,
           occurredAt: d'2026-05-01T00:00:00Z', availability: 'hot',
           piiClasses: [], vertical: 'rent'
         }`,
      );
      cleanAssetId = String(cleanAsset?.[0]?.id);
      const [cleanFrag] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_fragment CONTENT {
           assetId: $assetId, locator: { kind: 'pageRegion' }, piiClasses: []
         }`,
        { assetId: cleanAsset?.[0]?.id },
      );
      cleanFragmentId = String(cleanFrag?.[0]?.id);
      await db.query(
        `CREATE derived_representation CONTENT {
           subjectId: $subjectId, subjectKind: 'fragment', kind: 'caption',
           content: $content, producerVersion: 'e2e-1'
         }`,
        { subjectId: cleanFrag?.[0]?.id, content: CLEAN_CAPTION },
      );
      // UNCLASSED: fragment piiClasses NONE — fail-closed.
      const [unclassedAsset] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT {
           modality: 'image', mediaType: 'image/jpeg',
           byteHash: 'e2e-unclassed-hash', byteLength: 100,
           occurredAt: d'2026-05-02T00:00:00Z', availability: 'hot',
           piiClasses: [], vertical: 'rent'
         }`,
      );
      const [unclassedFrag] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_fragment CONTENT {
           assetId: $assetId, locator: { kind: 'pageRegion' }
         }`,
        { assetId: unclassedAsset?.[0]?.id },
      );
      await db.query(
        `CREATE derived_representation CONTENT {
           subjectId: $subjectId, subjectKind: 'fragment', kind: 'caption',
           content: $content, producerVersion: 'e2e-1'
         }`,
        { subjectId: unclassedFrag?.[0]?.id, content: UNCLASSED_CAPTION },
      );
      // OTHERUSER: clean fragment, but the asset belongs to another user.
      const [otherAsset] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT {
           modality: 'image', mediaType: 'image/jpeg',
           byteHash: 'e2e-other-hash', byteLength: 100,
           occurredAt: d'2026-05-03T00:00:00Z', availability: 'hot',
           piiClasses: [], vertical: 'rent', userId: 'u_other'
         }`,
      );
      const [otherFrag] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_fragment CONTENT {
           assetId: $assetId, locator: { kind: 'pageRegion' }, piiClasses: []
         }`,
        { assetId: otherAsset?.[0]?.id },
      );
      await db.query(
        `CREATE derived_representation CONTENT {
           subjectId: $subjectId, subjectKind: 'fragment', kind: 'caption',
           content: $content, producerVersion: 'e2e-1'
         }`,
        { subjectId: otherFrag?.[0]?.id, content: OTHERUSER_CAPTION },
      );
      // 0113 column for the capability-satisfaction pin (test 4).
      await db.query(
        `UPDATE knowledge_predicate SET requiredEvidenceCapability = 'visual',
           updatedAt = time::now()
         WHERE predicateId = 'status'`,
      );
    });
    f.app.get(PredicateRegistryService).invalidate(f.companyId);
  });

  afterEach(() => {
    for (const k of FLAG_KEYS) delete process.env[k];
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('CONTROL — both flags off: no media section, no evidenceCitations, serves as today', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: ANSWER, citedFactIds: [factId] }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: 'u_frag' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(ANSWER);
    expect(res.body.evidenceCitations).toBeUndefined();
    expect(state.calls.length).toBe(2);
    expect(state.calls[0]!.user).not.toContain('Media evidence');
    expect(state.calls[0]!.user).not.toContain(CLEAN_CAPTION);
    expect(state.calls[1]!.user).not.toContain('Non-text evidence');
  });

  it('lane ON: the clean caption renders for generator AND verifier; fenced fragments never appear', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: ANSWER, citedFactIds: [factId] }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: 'u_frag' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(ANSWER);
    // Citations flag off → no id headers, no evidenceCitations.
    expect(res.body.evidenceCitations).toBeUndefined();
    const genPrompt = state.calls[0]!.user;
    expect(genPrompt).toContain('Media evidence');
    expect(genPrompt).toContain(`[capability:visual] (image caption, 2026-05-01) ${CLEAN_CAPTION}`);
    expect(genPrompt).not.toContain('[evidence_fragment:');
    // The fences held: unclassified and other-user captions never render.
    expect(genPrompt).not.toContain(UNCLASSED_CAPTION);
    expect(genPrompt).not.toContain(OTHERUSER_CAPTION);
    // Verifier parity: the SAME lines arrive as the non-text section.
    const verifyPrompt = state.calls[1]!.user;
    expect(verifyPrompt).toContain('Non-text evidence');
    expect(verifyPrompt).toContain(CLEAN_CAPTION);
  });

  it('citations ON: id headers render; cited ids resolve through the rendered-set fence', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    process.env.EVIDENCE_FRAGMENT_CITATIONS = '1';
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: ANSWER,
        citedFactIds: [factId],
        // One rendered id + one hallucinated — the fence must drop the latter.
        citedFragmentIds: [cleanFragmentId, 'evidence_fragment:hallucinated'],
      }),
      VERIFY_SUPPORTED,
    ]);
    const res = await synth({ query: QUERY, userId: 'u_frag' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBe(ANSWER);
    const genPrompt = state.calls[0]!.user;
    expect(genPrompt).toContain(`[${cleanFragmentId}]`);
    // The schema gained the affordance (strict json_schema carries it).
    expect(JSON.stringify(state.calls[0]!.request)).toContain('citedFragmentIds');
    expect(res.body.evidenceCitations).toEqual([
      {
        fragmentId: cleanFragmentId,
        assetId: cleanAssetId,
        capability: 'visual',
        excerpt: CLEAN_CAPTION,
        occurredAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    // Fact citations stayed fact-only (the #376 separation).
    expect(res.body.citations.map((c: { factId: string }) => c.factId)).toContain(factId);
  });

  it('capability satisfaction: visual-required predicate SERVES with a cited visual fragment, abstains without', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    process.env.EVIDENCE_FRAGMENT_CITATIONS = '1';
    process.env.FOVEA_EVIDENCE_CAPABILITY = '1';
    // With the fragment cited: the 0113 gate is SATISFIED — serves.
    const cited = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({
        answer: ANSWER,
        citedFactIds: [factId],
        citedFragmentIds: [cleanFragmentId],
      }),
      VERIFY_SUPPORTED,
    ]);
    const served = await synth({ query: QUERY, userId: 'u_frag' });
    expect(served.status).toBe(201);
    expect(served.body.answer).toBe(ANSWER);
    expect(served.body.reason).toBeUndefined();
    expect(cited.calls.length).toBe(2);
    // Without it: text-only support for a visual requirement — abstains.
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: ANSWER, citedFactIds: [factId], citedFragmentIds: [] }),
      VERIFY_SUPPORTED,
    ]);
    const abstained = await synth({ query: QUERY, userId: 'u_frag' });
    expect(abstained.status).toBe(201);
    expect(abstained.body.answer).not.toBe(ANSWER);
    expect(abstained.body.reason).toBe('evidence_capability_unmet');
  });

  it('consent STALE ⇒ the lane serves nothing (0112 fence), then restores', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE domain_pack SET acceptedModalitiesChecksum = 'stale-e2e'
         WHERE packId = 'media_pack_e2e'`);
    });
    try {
      const state = mockSynthesizeOpenAi(f.app, [
        JSON.stringify({ answer: ANSWER, citedFactIds: [factId] }),
        VERIFY_SUPPORTED,
      ]);
      const res = await synth({ query: QUERY, userId: 'u_frag' });
      expect(res.status).toBe(201);
      expect(state.calls[0]!.user).not.toContain('Media evidence');
      expect(state.calls[0]!.user).not.toContain(CLEAN_CAPTION);
    } finally {
      await surreal.withCompany(f.companyId, async (db) => {
        await db.query(
          `UPDATE domain_pack SET acceptedModalitiesChecksum = $checksum
             WHERE packId = 'media_pack_e2e'`,
          { checksum: CURRENT_CHECKSUM },
        );
      });
    }
  });
});
