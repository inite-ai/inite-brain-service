/**
 * Coverage-scan HNSW parity against a REAL SurrealDB (V11 §5): the
 * approximate dense leg must return the same records as the exact
 * brute scan on a seeded world, and a tenant WITHOUT the indexes must
 * fall back to the brute output — flipping coverageScanMode per tenant
 * is safe mid-rollout. Runs on the deterministic StubEmbedder, so both
 * modes embed identical vectors; zero LLM/judge cost.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EmbedderService } from '../src/ai/embedder.service';
import { MentionScanService } from '../src/synthesize/mention-scan.service';
import { QueryArcService } from '../src/synthesize/query-arc.service';
import type { CoverageScanTuning } from '../src/synthesize/scan-leg';

describe('coverage-scan HNSW parity (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const HNSW: CoverageScanTuning = { mode: 'hnsw', ef: 400, overfetch: 4 };

  // Topic extraction strips this to exactly 'parser project'. The
  // matches operator is AND-semantics over the analyzed tokens
  // (verified on 3.1.5), so the seeded texts must contain EVERY topic
  // token for the lexical leg to fire — a looser phrasing would leave
  // the StubEmbedder's hash-vectors alone under the dense floor.
  const ORDER_QUERY = 'List the order of parser project';
  const ARC_QUERY = 'Summarize the parser project';

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_scan_parity_e2e' });
    const surreal = f.app.get(SurrealService);
    const embedder = f.app.get(EmbedderService);

    // Segments: one per day, seeded directly (derived state, 0075).
    const segments = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const day = `2026-01-${String(i + 2).padStart(2, '0')}`;
        const text = `[${day}] user: parser project note ${i} — aspect ${i}`;
        return {
          conversationId: 'conv_parity',
          seq: i,
          episodeIds: [],
          text,
          occurredAt: new Date(`${day}T10:00:00Z`),
          recorder: 'test-seeder',
          embedding: await embedder.embed(text),
        };
      }),
    );
    const seeded = await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`INSERT INTO episode_segment $rows`, { rows: segments });
      const [cnt] = await db.query<[Array<{ count: number }>]>(
        `SELECT count() FROM episode_segment WHERE embedding != NONE GROUP ALL`,
      );
      return cnt?.[0]?.count ?? 0;
    });
    expect(seeded).toBe(8);

    // Facts: through the ingest endpoint (embedding server-side).
    for (let i = 0; i < 8; i += 1) {
      const day = `2026-01-${String(i + 2).padStart(2, '0')}`;
      const res = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'work', id: 'parity_subject' },
          predicate: `work_update_${i}`,
          object: `parser project step ${i}: milestone ${i} reached`,
          validFrom: day,
          confidence: 0.9,
          source: { vertical: 'work', recorder: 'bot' },
        });
      expect([200, 201]).toContain(res.status);
    }
  }, 120_000);

  afterAll(async () => {
    if (f) await f.close();
  });

  it('hnsw mode without indexes falls back to the brute output', async () => {
    const mention = f.app.get(MentionScanService);
    const brute = await mention.mentionLines({
      companyId: f.companyId,
      query: ORDER_QUERY,
      callerScopes: [],
    });
    expect(brute.length).toBeGreaterThan(0);
    const viaHnsw = await mention.mentionLines({
      companyId: f.companyId,
      query: ORDER_QUERY,
      callerScopes: [],
      scan: HNSW,
    });
    expect(viaHnsw).toEqual(brute);
  });

  it('after index build, both lanes return identical output in both modes', async () => {
    const create = await f.http.post('/v1/admin/maintenance/hnsw').set(auth()).send({});
    expect(create.status).toBe(201);
    expect(create.body.indexes).toContain('segment_embedding_hnsw');

    const mention = f.app.get(MentionScanService);
    const arc = f.app.get(QueryArcService);

    const bruteMention = await mention.mentionLines({
      companyId: f.companyId,
      query: ORDER_QUERY,
      callerScopes: [],
    });
    const hnswMention = await mention.mentionLines({
      companyId: f.companyId,
      query: ORDER_QUERY,
      callerScopes: [],
      scan: HNSW,
    });
    expect(bruteMention.length).toBeGreaterThan(0);
    expect(hnswMention).toEqual(bruteMention);

    const bruteArc = await arc.arcLines({
      companyId: f.companyId,
      query: ARC_QUERY,
      callerScopes: [],
    });
    const hnswArc = await arc.arcLines({
      companyId: f.companyId,
      query: ARC_QUERY,
      callerScopes: [],
      scan: HNSW,
    });
    expect(bruteArc.length).toBeGreaterThan(0);
    expect(hnswArc).toEqual(bruteArc);
    // The arc record renders ISO days even though the driver returns
    // Date objects (the mergeFactLegs normalization).
    expect(bruteArc[0]).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] /);
  });

  it("lex='or_terms' surfaces partial-topic rows the AND matcher cannot", async () => {
    // The A2 class: the row mentions ONE topic word ('parser', never
    // 'project'), so the legacy phrase matcher — AND-semantics over
    // analyzed tokens — can never return it as a lexical hit. Under
    // or_terms it is a hit by construction. Executed against a REAL
    // SurrealDB, this also pins the rewrite's operator semantics:
    // unique match refs, the parenthesized disjunction ahead of the
    // gate tail, and the sum-of-max score projection all parse and
    // plan on the FULLTEXT indexes. (No phrase-side absence assert:
    // the dense leg may legitimately pick the row up by embedding —
    // the rewrite claim is about the lexical leg only.)
    const surreal = f.app.get(SurrealService);
    const embedder = f.app.get(EmbedderService);
    const text = '[2026-01-20] user: wrapping up the parser rewrite tonight';
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`INSERT INTO episode_segment $rows`, {
        rows: [
          {
            conversationId: 'conv_partial',
            seq: 0,
            episodeIds: [],
            text,
            occurredAt: new Date('2026-01-20T10:00:00Z'),
            recorder: 'test-seeder',
            embedding: await embedder.embed(text),
          },
        ],
      });
    });
    const fact = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'work', id: 'parity_subject' },
        predicate: 'work_update_partial',
        object: 'parser rewrite kickoff planned',
        validFrom: '2026-01-20',
        confidence: 0.9,
        source: { vertical: 'work', recorder: 'bot' },
      });
    expect([200, 201]).toContain(fact.status);

    const mention = f.app.get(MentionScanService);
    const orTermMentions = await mention.mentionLines({
      companyId: f.companyId,
      query: ORDER_QUERY,
      callerScopes: [],
      lex: 'or_terms',
    });
    expect(orTermMentions.some((l) => l.includes('parser rewrite tonight'))).toBe(true);

    const arc = f.app.get(QueryArcService);
    const orTermArc = await arc.arcLines({
      companyId: f.companyId,
      query: ARC_QUERY,
      callerScopes: [],
      lex: 'or_terms',
    });
    expect(orTermArc.some((l) => l.includes('parser rewrite kickoff'))).toBe(true);
  });
});
