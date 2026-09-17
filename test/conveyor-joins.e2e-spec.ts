/**
 * The joins a full-chain trace on the prod assembly found broken, pinned
 * against a real store (2026-09-16, docs/eval/conveyor-trace-2026-09.md).
 *
 * A stock deployment routes every mention through the document pipeline
 * (INGEST_MENTION_VIA_DOCUMENT=1). On that path three things the ingest
 * conveyor declares as `always` were not happening:
 *
 *   - `capture`: no L0 episode was written — `episode = 0` after four
 *     turns with SCENES_SEGMENTATION_ENABLED=1, so the whole episodic /
 *     belief plane had nothing to read;
 *   - `resolve-facts` stamped validFrom = the document's occurredAt on
 *     every fact — INGEST_EVENT_TIME_EXTRACTION=1 in the deploy, and its
 *     only reader lived on the other path;
 *   - the entity judge saw an incoming entity's facts but not its edges.
 *
 * And DEBUG_TRACE_PERSIST wrote zero rows on SurrealDB 3.x (NULL for an
 * option<object>, a string for a datetime), which no unit spec could see
 * because they fake the store.
 */
import { SurrealService } from '../src/db/surreal.service';
import { TraceBufferService } from '../src/common/trace-buffer.service';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

interface FactRow {
  predicate: string;
  object: string;
  validFrom: string | Date;
  source?: { episodeIds?: string[] };
}

describe('conveyor joins on the document path', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    process.env.INGEST_EVENT_TIME_EXTRACTION = '1';
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_SCHEDULED_MAINTENANCE = '1';
    process.env.DEBUG_TRACE_PERSIST = '1';
    f = await createApp({ companyId: 'co_conveyor_joins_e2e' });
  });

  afterAll(async () => {
    for (const k of [
      'DOCUMENT_INGEST_ENABLED',
      'INGEST_MENTION_VIA_DOCUMENT',
      'INGEST_EVENT_TIME_EXTRACTION',
      'EPISODE_SUBSTRATE_ENABLED',
      'SCENES_SEGMENTATION_ENABLED',
      'SCENES_SCHEDULED_MAINTENANCE',
      'DEBUG_TRACE_PERSIST',
    ]) {
      delete process.env[k];
    }
    if (f) await f.close();
  });

  afterEach(() => f.extractor.setScript(null));

  const query = <T>(sql: string, vars?: Record<string, unknown>): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[T[]]>(sql, vars);
      return (rows as T[]) ?? [];
    });
  };

  it('captures the L0 episode, walks the fact back to it, and stamps the date the clause names', async () => {
    f.extractor.setScript({
      entities: [{ name: 'Артём Соколов', type: 'staff' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'pilot_launch_date',
          object: '3 марта 2026',
          confidence: 0.9,
          clause: 'Пилотный запуск запланирован на 3 марта 2026.',
        },
      ],
      edges: [],
    });
    const res = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'Артём Соколов: пилотный запуск запланирован на 3 марта 2026.',
        userId: 'u-joins',
        emittedAt: '2026-09-16T10:00:00.000Z',
        contextRef: { vertical: 'chat', conversationId: 'c-joins', messageId: 'm1' },
      })
      .expect(201);
    expect(res.body.skipped).toBe(false);
    expect(res.body.extractedFactIds).toHaveLength(1);

    // capture: the turn is an episode row, marked for segmentation.
    const episodes = await query<{ id: unknown; text: string }>(
      `SELECT id, text FROM episode WHERE conversationId = 'c-joins'`,
    );
    expect(episodes).toHaveLength(1);
    const dirty = await query<{ conversationId: string }>(
      `SELECT conversationId FROM scene_dirty_conversation WHERE conversationId = 'c-joins'`,
    );
    expect(dirty).toHaveLength(1);

    // resolve-facts: the fact walks back to the episode, and validFrom is
    // the day the clause NAMES, not the day it was said.
    const facts = await query<FactRow>(
      `SELECT predicate, object, validFrom, source FROM knowledge_fact WHERE predicate = 'pilot_launch_date'`,
    );
    expect(facts).toHaveLength(1);
    expect(String(facts[0]!.validFrom)).toMatch(/^2026-03-03/);
    expect(facts[0]!.source?.episodeIds).toEqual([String(episodes[0]!.id)]);
  });

  it('persists a debug trace on SurrealDB 3.x — datetime cast, absent error as NONE', async () => {
    const traces = f.app.get(TraceBufferService);
    expect(traces.persistsToDb()).toBe(true);
    await f.http
      .post('/v1/search')
      .set(auth())
      .set('X-Brain-Debug', '1')
      .send({ query: 'pilot launch', limit: 3 })
      .expect(201);
    // The write-through is fire-and-forget behind the response.
    let rows: Array<{ requestId: string; ts: unknown; errored: unknown }> = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      rows = await query(
        `SELECT requestId, ts, errored FROM debug_trace WHERE path = '/v1/search' AND companyId = $cid`,
        { cid: f.companyId },
      );
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows).toHaveLength(1);
    // A datetime came back as one (the driver's datetime wrapper or a
    // Date) — not the string the old statement tried to store.
    expect(JSON.stringify(rows[0]!.ts)).toMatch(/^"20\d\d-\d\d-\d\dT/);
    expect(rows[0]!.errored ?? undefined).toBeUndefined();
  });
});
