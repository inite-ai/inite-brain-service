/**
 * #916 step 4 on a real SurrealDB: a voice-affect pack is refused at
 * install without an allowed deployment context; with one, a person is
 * read only with their consent AND their recorded emotion-recognition
 * notice; withdrawing voice consent erases voice readings and leaves text
 * readings; export carries the voice reading without words.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';
import { VoiceAffectReaderService } from '../src/affect/voice-affect-reader.service';

const U = 'voice_user';
const voicePack: DomainPackManifest = {
  ...RELATIONSHIP_PACK,
  id: 'voice_coach',
  memoryModel: { modalities: ['text', 'audio'], voiceAffectInference: { retentionDays: 30 } },
};

describe('voice affect (0192)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let voice: VoiceAffectReaderService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const install = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: voicePack, acceptModalities: true, ...body });

  beforeAll(async () => {
    f = await createApp({ companyId: `co_voice_${Date.now()}` });
    surreal = f.app.get(SurrealService);
    voice = f.app.get(VoiceAffectReaderService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('install is refused without a context and at work; accepted for consumers', async () => {
    expect((await install({})).status).toBe(400);
    const work = await install({ deploymentContext: 'workplace' });
    expect(work.status).toBe(400);
    expect(JSON.stringify(work.body)).toContain('5(1)(f)');
    expect([200, 201]).toContain((await install({ deploymentContext: 'consumer' })).status);
    expect(await voice.tenantVoice(f.companyId)).toEqual({ retentionDays: 30 });
  });

  it('a person is eligible only with consent and a recorded notice', async () => {
    expect(await voice.eligiblePeople(f.companyId)).toEqual([]);
    await f.http
      .post(`/v1/users/${U}/consents`)
      .set(auth())
      .send({ purpose: 'voice_affect_inference', basis: 'explicit_consent', noticeVersion: 'v-1' });
    expect(await voice.eligiblePeople(f.companyId)).toEqual([]);
    await f.http
      .post(`/v1/users/${U}/safety-events`)
      .set(auth())
      .send({ type: 'emotion_recognition_notice_shown', protocolVersion: 'v-1' });
    expect(await voice.eligiblePeople(f.companyId)).toEqual([U]);
  });

  it('a voice reading is exported without words; withdrawal erases voice, keeps text', async () => {
    await surreal.withCompany(f.companyId, async (db) => {
      const [asset] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE evidence_asset CONTENT { modality: 'audio', mediaType: 'audio/ogg',
           byteHash: 'h1', byteLength: 10, occurredAt: time::now(), vertical: 'chat',
           userId: $u, availability: 'hot', storageRef: 'fs://x', meta: { speaker: 'self' } } RETURN id`,
        { u: U },
      );
      await voice.apply(f.companyId, U, {
        asset: {
          id: asset![0]!.id,
          storageRef: 'fs://x',
          mediaType: 'audio/ogg',
          occurredAt: new Date(),
        },
        segments: [{ startMs: 0, endMs: 3000, arousal: 0.8, confidence: 0.7 }],
      });
      const [ep] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE episode CONTENT { kind: 'turn', messageId: 'm1', text: 'x', occurredAt: time::now(),
           userId: $u, source: { vertical: 'chat' } } RETURN id`,
        { u: U },
      );
      await db.query(
        `CREATE affect_observation CONTENT { userId: $u, episodeId: $e, observedAt: time::now(),
           valence: -0.4, label: 'sadness', quote: 'x', spanStart: 0, spanEnd: 1, confidence: 0.6,
           readerVersion: 'affect-reader-v1' }`,
        { u: U, e: ep![0]!.id },
      );
    });
    const out = await f.http.get(`/v1/users/${U}/affect`).set(auth());
    const voiceObs = out.body.observations.find(
      (o: { modality: string }) => o.modality === 'voice',
    );
    expect(voiceObs).toMatchObject({ arousal: 0.8, startMs: 0, endMs: 3000 });
    expect(voiceObs.quote).toBeUndefined();
    const r = await f.http.delete(`/v1/users/${U}/consents/voice_affect_inference`).set(auth());
    expect(r.body.erased).toEqual({ observationsDeleted: 1 });
    const after = await f.http.get(`/v1/users/${U}/affect`).set(auth());
    expect(after.body.observations.map((o: { modality: string }) => o.modality)).toEqual(['text']);
  });
});
