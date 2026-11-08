/**
 * #909 step 4 on a real SurrealDB: the affect reader reads only what two
 * consents allow — the operator's (the pack's affectInference, accepted
 * at install) and the person's (affect_inference) — writes observations
 * that cite the person's exact words, never re-reads a turn, honours a
 * contest, hands the same work to a connected agent, sweeps retention,
 * and stops when consent is withdrawn. The model is a stub: no paid call.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import { AffectReaderService } from '../src/affect/affect-reader.service';
import { AffectReadingWorkService } from '../src/affect/affect-reading-work.service';
import { verifyWorkToken, type AffectTokenPayload } from '../src/common/harness-work-token';

const U = 'affect_reader_user';
const SELF = `user:${U}`;

/** A stub reader: every OWN turn containing "dread" yields one fear reading of "dread …". */
function stubModel(calls: { n: number }) {
  return {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ content: string }> }) => {
          calls.n += 1;
          const user = req.messages[1]!.content;
          const observations: unknown[] = [];
          for (const block of user.split('\n\n')) {
            const m = /^\[(t\d+)\] OWN[^\n]*\n([\s\S]*)$/.exec(block.trim());
            if (!m) continue;
            const at = m[2]!.indexOf('dread');
            if (at < 0) continue;
            observations.push({
              turn: m[1],
              quote: m[2]!.slice(at, at + 'dread the weigh-in'.length),
              valence: -0.6,
              label: 'fear',
              target: 'the weigh-in',
              confidence: 0.8,
            });
          }
          return { choices: [{ message: { content: JSON.stringify({ observations }) } }] };
        },
      },
    },
  };
}

describe('affect reader (0188)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let reader: AffectReaderService;
  const calls = { n: 0 };
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let seq = 0;

  const turn = async (speaker: string, text: string, conversationId = 'c1') => {
    seq += 1;
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE episode CONTENT {
           kind: 'turn', conversationId: $c, messageId: $m, speaker: $s, text: $t,
           occurredAt: time::now() + type::duration($off), userId: $u, source: { vertical: 'chat' } }`,
        { c: conversationId, m: `m${seq}`, s: speaker, t: text, off: `${seq}s`, u: U },
      );
    });
  };

  const count = async (table: string) =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM ${table} WHERE userId = $u`,
        {
          u: U,
        },
      );
      return (rows ?? []).length;
    });

  beforeAll(async () => {
    f = await createApp({ companyId: `co_affreader_${Date.now()}` });
    surreal = f.app.get(SurrealService);
    reader = f.app.get(AffectReaderService);
    (reader as unknown as { openai: unknown }).openai = stubModel(calls);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('the operator must accept the declaration at install', async () => {
    const refused = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: RELATIONSHIP_PACK });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('infers how a person feels');
    const ok = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: RELATIONSHIP_PACK, acceptModalities: true });
    expect([200, 201]).toContain(ok.status);
    expect(await reader.tenantInference(f.companyId)).toEqual({ from: 'text', retentionDays: 90 });
  });

  it('without the person’s consent nothing is read', async () => {
    await turn('coach', 'How is the week going?');
    await turn(SELF, 'Honestly I dread the weigh-in on Friday.');
    await turn(SELF, 'Thanks for asking.');
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(0);
    expect(await count('affect_observation')).toBe(0);
  });

  it('with consent: one observation citing the exact words; every own turn marked read, once', async () => {
    const c = await f.http
      .post(`/v1/users/${U}/consents`)
      .set(auth())
      .send({ purpose: 'affect_inference', basis: 'explicit_consent', noticeVersion: 'n-1' });
    expect(c.status).toBe(201);
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(1);
    expect(await count('affect_reading')).toBe(2);
    const out = await f.http.get(`/v1/users/${U}/affect`).set(auth());
    expect(out.body.observations).toHaveLength(1);
    expect(out.body.observations[0]).toMatchObject({
      label: 'fear',
      quote: 'dread the weigh-in',
      target: 'the weigh-in',
      assertion: 'inferred',
      inferredBy: { recorder: 'affect-reader-v1', modality: 'text' },
    });
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(1);
  });

  it('a contested reading is erased and never written again', async () => {
    const out = await f.http.get(`/v1/users/${U}/affect`).set(auth());
    const id = out.body.observations[0].observationId as string;
    const r = await f.http.post(`/v1/users/${U}/affect/${id}/contest`).set(auth());
    expect(r.status).toBe(201);
    expect(r.body.erased.observationsDeleted).toBe(1);
    await turn(SELF, 'I still dread the weigh-in, to be honest.', 'c2');
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(2);
    expect(await count('affect_observation')).toBe(0);
    expect(await count('affect_reading')).toBe(3);
  });

  it('a connected agent takes the same work and its answer goes through the same checks', async () => {
    await turn(SELF, 'Saturday went fine, but I dread the weigh-in next week.', 'c3');
    const work = f.app.get(AffectReadingWorkService);
    const batch = await work.take(f.companyId, { userId: U });
    expect(batch?.kind).toBe('affect_reading');
    const verdict = verifyWorkToken(batch!.token);
    const payload = (verdict as { payload: AffectTokenPayload }).payload;
    const own = payload.e.find(([, , o]) => o === 1)!;
    const result = {
      observations: [
        {
          turn: own[0],
          quote: 'went fine',
          valence: 0.4,
          label: 'joy',
          target: null,
          confidence: 0.7,
        },
        {
          turn: own[0],
          quote: 'not in the turn',
          valence: -1,
          label: 'anger',
          target: null,
          confidence: 0.9,
        },
      ],
    };
    const r = await work.submit(f.companyId, payload, result);
    expect(r).toMatchObject({ turns: 1, observations: 1 });
    expect(await work.take(f.companyId, { userId: U })).toBeNull();
  });

  it('retention: an observation older than the declared window is swept', async () => {
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE affect_observation SET observedAt = time::now() - 100d WHERE userId = $u`,
        { u: U },
      );
    });
    expect(await reader.sweep(f.companyId, 90)).toBe(1);
    expect(await count('affect_observation')).toBe(0);
  });

  it('withdrawing consent stops the reader', async () => {
    const r = await f.http.delete(`/v1/users/${U}/consents/affect_inference`).set(auth());
    expect(r.status).toBe(200);
    await turn(SELF, 'I dread the weigh-in.', 'c4');
    const before = calls.n;
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(before);
    expect(await count('affect_observation')).toBe(0);
  });
});
