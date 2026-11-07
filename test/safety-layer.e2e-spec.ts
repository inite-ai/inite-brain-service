/**
 * #916 step 2 on a real SurrealDB: the safety reader reads a person's own
 * words for risk only under an operator-accepted safetyMonitoring
 * declaration, quotes them, skips idiom (stub model), serves the signal to
 * a brain:read_pii caller, hands the same work to a connected agent; the
 * protocol record yields an identifier-free report that survives user
 * forget, which deletes the signals.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { RELATIONSHIP_PACK } from '../src/ai/domain-packs/relationship.pack';
import { SafetyReaderService } from '../src/affect/safety-reader.service';
import { AffectReadingWorkService } from '../src/affect/affect-reading-work.service';
import { EntitiesService } from '../src/entities/entities.service';
import { verifyWorkToken, type AffectTokenPayload } from '../src/common/harness-work-token';

const U = 'safety_user';
const SELF = `user:${U}`;

/** Stub reader: an OWN turn with "wake up" is concern; nothing else (idiom included). */
function stubModel(calls: { n: number }) {
  return {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ content: string }> }) => {
          calls.n += 1;
          const signals: unknown[] = [];
          for (const block of req.messages[1]!.content.split('\n\n')) {
            const m = /^\[(t\d+)\] OWN[^\n]*\n([\s\S]*)$/.exec(block.trim());
            if (!m || !m[2]!.includes("wouldn't wake up")) continue;
            signals.push({
              turn: m[1],
              quote: "wouldn't wake up",
              level: 'concern',
              confidence: 0.8,
            });
          }
          return { choices: [{ message: { content: JSON.stringify({ signals }) } }] };
        },
      },
    },
  };
}

describe('safety layer (0190)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let reader: SafetyReaderService;
  const calls = { n: 0 };
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  let seq = 0;
  const turn = async (speaker: string, text: string) => {
    seq += 1;
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE episode CONTENT { kind: 'turn', conversationId: 'c1', messageId: $m, speaker: $s,
           text: $t, occurredAt: time::now() + type::duration($off), userId: $u,
           scope: [$tag], source: { vertical: 'chat' } }`,
        { m: `m${seq}`, s: speaker, t: text, off: `${seq}s`, u: U, tag: SELF },
      );
    });
  };

  beforeAll(async () => {
    f = await createApp({ companyId: `co_safety_${Date.now()}` });
    surreal = f.app.get(SurrealService);
    reader = f.app.get(SafetyReaderService);
    (reader as unknown as { openai: unknown }).openai = stubModel(calls);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('without the operator’s declaration nothing is read', async () => {
    await turn('coach', 'How are you holding up?');
    await turn(SELF, "Honestly some nights I wish I just wouldn't wake up.");
    await turn(SELF, 'And this traffic is killing me.');
    expect(await reader.runTenant(f.companyId)).toMatchObject({ skipped: expect.any(String) });
    expect(calls.n).toBe(0);
  });

  it('with it: one concern signal quoting the words; the idiom yields nothing', async () => {
    const ok = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: RELATIONSHIP_PACK, acceptModalities: true });
    expect([200, 201]).toContain(ok.status);
    await reader.runTenant(f.companyId);
    expect(calls.n).toBe(1);
    const ctx = await f.app.get(EntitiesService).getRelationshipContext({
      companyId: f.companyId,
      userId: U,
      scopes: ['brain:read', 'brain:read_pii'],
    });
    expect(ctx.safety?.signals).toHaveLength(1);
    expect(ctx.safety?.signals[0]).toMatchObject({ level: 'concern', quote: "wouldn't wake up" });
    const plain = await f.app.get(EntitiesService).getRelationshipContext({
      companyId: f.companyId,
      userId: U,
      scopes: ['brain:read'],
    });
    expect(plain.safety).toBeUndefined();
  });

  it('a connected agent takes the safety work and its answer is checked the same way', async () => {
    await turn(SELF, "Some days I still wish I wouldn't wake up, to be honest.");
    const work = f.app.get(AffectReadingWorkService);
    const batch = await work.takeSafety(f.companyId, { userId: U });
    expect(batch?.kind).toBe('safety_reading');
    const payload = (verifyWorkToken(batch!.token) as { payload: AffectTokenPayload }).payload;
    const own = payload.e.find(([, , o]) => o === 1)!;
    const out = await work.submit(f.companyId, payload, {
      signals: [
        { turn: own[0], quote: "wish I wouldn't wake up", level: 'concern', confidence: 0.7 },
        { turn: own[0], quote: 'not there', level: 'urgent', confidence: 0.9 },
      ],
    });
    expect(out).toMatchObject({ turns: 1, signals: 1, urgent: 0 });
  });

  it('the protocol record reports counts without identifiers, and survives forget', async () => {
    for (const type of ['ai_disclosure_shown', 'crisis_referral_shown']) {
      const r = await f.http
        .post(`/v1/users/${U}/safety-events`)
        .set(auth())
        .send({ type, protocolVersion: 'p-1', resource: '988' });
      expect(r.status).toBe(201);
    }
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const report = async () =>
      (await f.http.get('/v1/admin/safety/report').query({ from, to }).set(auth())).body as {
        rows: Array<{ type: string; count: number }>;
      };
    const before = await report();
    expect(JSON.stringify(before)).not.toContain(U);
    expect(before.rows.map((r) => [r.type, r.count]).sort()).toEqual([
      ['ai_disclosure_shown', 1],
      ['crisis_referral_shown', 1],
    ]);
    const forget = await f.http.post(`/v1/users/${U}/forget`).set(auth());
    expect([200, 201]).toContain(forget.status);
    expect((await report()).rows).toEqual(before.rows);
    const left = await surreal.withCompany(f.companyId, async (db) => {
      const [risks, events] = await db.query<[unknown[], unknown[]]>(
        `SELECT VALUE id FROM risk_signal WHERE userId = $u;
         SELECT VALUE id FROM safety_event WHERE userId = $u;`,
        { u: U },
      );
      return [...(risks ?? []), ...(events ?? [])];
    });
    expect(left).toEqual([]);
  });
});
