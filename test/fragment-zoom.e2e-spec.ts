/**
 * Fragment zoom e2e (FOVEA_FRAGMENT_ZOOM, MM-zoom PR3) over a real
 * SurrealDB (testcontainer). NO paid call — the OpenAI client is the
 * scripted stub (mockSynthesizeOpenAi), the fragment-lane e2e idiom.
 *
 * Substrate: one tenant with a consented media pack and ONE clean
 * fragment whose derived caption is LONGER than the lane's 600-char
 * excerpt cap — the grounding detail lives in the TAIL the cap hides
 * from the primary audit.
 *
 * Pins:
 *   1. CONTROL (lane on, zoom OFF): a verifier-fail abstains exactly as
 *      today — TWO LLM calls (generate + verify), no extra read, the
 *      byte-identity contract;
 *   2. FLIP: zoom ON, primary verdict unsupported → ONE re-verify whose
 *      prompt carries the fuller derived text (the tail), verdict flips,
 *      the SAME generated answer serves (never regenerated — exactly one
 *      generator call);
 *   3. UNCHANGED + BOUNDED: the re-verify fails too → the static
 *      verifier_failed abstain, and EXACTLY three LLM calls total — the
 *      monotone single step never re-zooms.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';
import {
  declaredModalitySection,
  modalitiesChecksum,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

const FLAG_KEYS = ['RETRIEVAL_FRAGMENT_LANE', 'FOVEA_FRAGMENT_ZOOM'] as const;

describe('Fragment zoom e2e', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};

  let factId: string;

  // The excerpt head lexically matches the query (BM25 leg); the TAIL —
  // beyond the 600-char cap — holds the detail only the zoom can show
  // the auditor.
  const CAPTION_HEAD = 'whiteboard photo: the evacuation plan pinned in the ops room. ';
  const CAPTION_TAIL = 'The plan names the north stairwell as the primary evacuation route.';
  const CAPTION =
    CAPTION_HEAD + 'detail '.repeat(Math.ceil((601 - CAPTION_HEAD.length) / 7)) + CAPTION_TAIL;
  const QUERY = 'evacuation plan pinned';
  const ANSWER = 'Take the north stairwell.';
  const GEN = JSON.stringify({ answer: ANSWER, citedFactIds: [] });
  const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });
  const VERIFY_UNSUPPORTED = JSON.stringify({
    verdict: 'unsupported',
    unsupportedClaims: [ANSWER],
  });

  const MANIFEST = {
    memoryModel: { modalities: ['text', 'image'] },
  } as unknown as DomainPackManifest;

  const synth = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ limit: 5, ...body });

  beforeAll(async () => {
    expect(CAPTION.length).toBeGreaterThan(600);
    for (const k of [...FLAG_KEYS, 'RETRIEVAL_ABSTENTION_CALIBRATION']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Pin abstention off so a thin-evidence query never pre-abstains
    // before generation (the fragment-lane e2e discipline).
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    f = await createApp({ companyId: 'co_fragment_zoom_e2e' });

    // One fact so retrieval yields evidence (the generator needs a
    // non-empty fact set to run at all).
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
        userId: 'u_zoom',
      });
    expect([200, 201]).toContain(r.status);
    factId = r.body.factId as string;
    expect(factId).toBeTruthy();

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE domain_pack CONTENT {
           packId: 'media_pack_zoom_e2e', version: '1.0.0',
           manifest: $manifest,
           acceptedModalities: true,
           acceptedModalitiesChecksum: $checksum
         }`,
        { manifest: MANIFEST, checksum: modalitiesChecksum(declaredModalitySection(MANIFEST)) },
      );
      const [asset] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT {
           modality: 'image', mediaType: 'image/jpeg',
           byteHash: 'e2e-zoom-hash', byteLength: 100,
           occurredAt: d'2026-05-01T00:00:00Z', availability: 'hot',
           piiClasses: [], vertical: 'rent'
         }`,
      );
      const [frag] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_fragment CONTENT {
           assetId: $assetId, locator: { kind: 'pageRegion' }, piiClasses: []
         }`,
        { assetId: asset?.[0]?.id },
      );
      await db.query(
        `CREATE derived_representation CONTENT {
           subjectId: $subjectId, subjectKind: 'fragment', kind: 'caption',
           content: $content, producerVersion: 'e2e-1'
         }`,
        { subjectId: frag?.[0]?.id, content: CAPTION },
      );
    });
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

  it('CONTROL — zoom off: a verifier-fail abstains as today, TWO calls, no extra read', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    const state = mockSynthesizeOpenAi(f.app, [GEN, VERIFY_UNSUPPORTED]);
    const res = await synth({ query: QUERY, userId: 'u_zoom' });
    expect(res.status).toBe(201);
    expect(res.body.answer).toBeNull();
    expect(res.body.reason).toBe('verifier_failed');
    // Byte-identity pin: the verifier ran EXACTLY once — no zoom call.
    expect(state.calls.length).toBe(2);
    // The primary audit saw the capped excerpt: head yes, tail no.
    expect(state.calls[1]!.user).toContain(CAPTION_HEAD.trim());
    expect(state.calls[1]!.user).not.toContain(CAPTION_TAIL);
  });

  it('FLIP — zoom on: ONE re-verify over the fuller text, the SAME answer serves', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    process.env.FOVEA_FRAGMENT_ZOOM = '1';
    const state = mockSynthesizeOpenAi(f.app, [GEN, VERIFY_UNSUPPORTED, VERIFY_SUPPORTED]);
    const res = await synth({ query: QUERY, userId: 'u_zoom' });
    expect(res.status).toBe(201);
    // Served on the flip — the generator's own answer, never regenerated.
    expect(res.body.answer).toBe(ANSWER);
    expect(res.body.reason).toBeUndefined();
    expect(state.calls.length).toBe(3);
    // Exactly ONE generator call (call 0); calls 1+2 are audits.
    expect(state.calls[0]!.user).toContain('Query:');
    // The primary audit saw only the capped excerpt …
    expect(state.calls[1]!.user).not.toContain(CAPTION_TAIL);
    // … the zoom re-verify saw the fuller derived text, same section.
    expect(state.calls[2]!.user).toContain('Non-text evidence');
    expect(state.calls[2]!.user).toContain(CAPTION_TAIL);
    // Re-verify ONLY: the audit request, not a generation (same answer).
    expect(state.calls[2]!.user).toContain(ANSWER);
  });

  it('UNCHANGED + BOUNDED — a failing re-verify falls through to the static abstain, EXACTLY three calls', async () => {
    process.env.RETRIEVAL_FRAGMENT_LANE = '1';
    process.env.FOVEA_FRAGMENT_ZOOM = '1';
    // The queue's last response repeats — a second zoom step would still
    // see 'unsupported'; the call COUNT is the single-step pin.
    const state = mockSynthesizeOpenAi(f.app, [GEN, VERIFY_UNSUPPORTED, VERIFY_UNSUPPORTED]);
    const res = await synth({ query: QUERY, userId: 'u_zoom' });
    expect(res.status).toBe(201);
    // The downgrade path is unchanged — the CONTROL result, byte for byte.
    expect(res.body.answer).toBeNull();
    expect(res.body.reason).toBe('verifier_failed');
    // Monotone single step: generate + verify + ONE zoom re-verify.
    expect(state.calls.length).toBe(3);
  });
});
