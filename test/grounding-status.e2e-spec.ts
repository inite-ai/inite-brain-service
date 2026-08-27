/**
 * Drift-1 claim grounding e2e (migration 0115, real SurrealDB): the
 * post-resolve stamp (EVIDENCE_GROUNDING_STAMP) end-to-end through
 * POST /v1/ingest/fact → GET /v1/facts/:id —
 *
 *  - stamp ON + bare source            → groundingStatus 'ungrounded'
 *  - stamp ON + source.evidence[]      → 'grounded'
 *  - stamp ON + source.conversationId  → 'grounded'
 *  - all flags OFF                     → NO groundingStatus key on the
 *    wire (byte-identity), even though the column now exists (0115);
 *  - stamp ON: a malformed source.episodeIds is a 400 (spoof guard);
 *    stamp OFF: the same body is accepted (byte-identical acceptance).
 */
import { AppFixture, createApp } from './app-fixture';

describe('claim grounding status (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const SAVED = {
    stamp: process.env.EVIDENCE_GROUNDING_STAMP,
    factsApi: process.env.FACTS_API_ENABLED,
  };

  beforeAll(async () => {
    process.env.FACTS_API_ENABLED = '1';
    f = await createApp({ companyId: 'co_grounding_e2e' });
  });

  afterAll(async () => {
    if (SAVED.stamp === undefined) delete process.env.EVIDENCE_GROUNDING_STAMP;
    else process.env.EVIDENCE_GROUNDING_STAMP = SAVED.stamp;
    if (SAVED.factsApi === undefined) delete process.env.FACTS_API_ENABLED;
    else process.env.FACTS_API_ENABLED = SAVED.factsApi;
    await f.close();
  });

  afterEach(() => {
    delete process.env.EVIDENCE_GROUNDING_STAMP;
  });

  let n = 0;
  async function ingest(source: Record<string, unknown>): Promise<string> {
    n++;
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: `cust_grounding_${n}` },
        predicate: 'complained_about',
        object: `observation ${n}`,
        validFrom: new Date('2026-04-01').toISOString(),
        source,
        confidence: 0.7,
      });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('INSERTED');
    return res.body.factId as string;
  }

  async function readFact(factId: string) {
    const res = await f.http.get(`/v1/facts/${encodeURIComponent(factId)}`).set(auth());
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  it('stamp ON + bare source → ungrounded', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const factId = await ingest({ vertical: 'rent', recorder: 'agent' });
    const fact = await readFact(factId);
    expect(fact.groundingStatus).toBe('ungrounded');
  });

  it('stamp ON + source.evidence[] → grounded', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const factId = await ingest({
      vertical: 'rent',
      evidence: [{ kind: 'message', ref: 'msg_ev_1' }],
    });
    const fact = await readFact(factId);
    expect(fact.groundingStatus).toBe('grounded');
  });

  it('stamp ON + source.conversationId → grounded', async () => {
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const factId = await ingest({ vertical: 'rent', conversationId: 'conv_g1' });
    const fact = await readFact(factId);
    expect(fact.groundingStatus).toBe('grounded');
  });

  it('all flags OFF → the wire shape carries NO groundingStatus key (byte-identity)', async () => {
    const factId = await ingest({ vertical: 'rent', recorder: 'agent' });
    const fact = await readFact(factId);
    expect('groundingStatus' in fact).toBe(false);
  });

  it('stamp ON: malformed source.episodeIds → 400; stamp OFF: same body accepted', async () => {
    const body = {
      entityRef: { vertical: 'rent', id: 'cust_grounding_spoof' },
      predicate: 'complained_about',
      object: 'spoof attempt',
      validFrom: new Date('2026-04-01').toISOString(),
      source: { vertical: 'rent', episodeIds: [42, ''] },
      confidence: 0.7,
    };
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    const rejected = await f.http.post('/v1/ingest/fact').set(auth()).send(body);
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.message)).toContain('source.episodeIds');
    delete process.env.EVIDENCE_GROUNDING_STAMP;
    const accepted = await f.http.post('/v1/ingest/fact').set(auth()).send(body);
    expect(accepted.status).toBe(201);
  });
});
