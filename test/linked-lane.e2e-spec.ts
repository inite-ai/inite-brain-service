/**
 * The linked lane (W7) end to end on a REAL SurrealDB against the fake
 * GitLab: a source that keeps its own index, asked at query time.
 *
 *   - a `mode: 'linked'` connection is never walked: syncing it is
 *     refused by name, and it has no catalogue;
 *   - a search asks it, and the hits ride BESIDE the ranking;
 *   - every answer is anchored to the `tool_observation` the call wrote,
 *     and that row is content-free;
 *   - the ref is accepted by `ingest_document`, which is what turns a
 *     hit into memory the ordinary way;
 *   - with the flag off, nothing is asked and no observation is written.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeGitlab, type FakeGitlab } from './fixtures/fake-gitlab';

const COMPANY = 'co_linked_lane_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_KIND_GITLAB',
  'SOURCE_OAUTH_GITLAB_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'SOURCE_LINKED',
  'TOOL_OBSERVATIONS_ENABLED',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
];

describe('the linked lane (e2e)', () => {
  let f: AppFixture;
  let gl: FakeGitlab;
  const saved: Record<string, string | undefined> = {};
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    gl = await startFakeGitlab();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_KIND_GITLAB: '1',
      SOURCE_OAUTH_GITLAB_BASE_URL: gl.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      SOURCE_LINKED: '1',
      TOOL_OBSERVATIONS_ENABLED: '1',
      DOCUMENT_INGEST_ENABLED: '1',
    });
    f = await createApp({ companyId: COMPANY });
    gl.tokens.add('glpat-linked');
    gl.issues = [
      {
        iid: 41,
        title: 'The payments gateway drops every third webhook',
        description: 'Retries queue behind the dead-letter sweep.',
        author: { username: 'gracehopper', name: 'Grace Hopper' },
        createdAt: '2026-09-10T09:00:00Z',
        updatedAt: '2026-09-12T09:00:00Z',
      },
      {
        iid: 42,
        title: 'Warehouse sensors go quiet at -20C',
        description: 'Unrelated.',
        author: { username: 'linus' },
        createdAt: '2026-09-11T09:00:00Z',
        updatedAt: '2026-09-11T09:00:00Z',
      },
    ];
    gl.files = new Map([['docs/payments.md', '# Payments\n\nThe gateway retries three times.']]);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await gl.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const search = (query: string) => f.http.post('/v1/search').set(auth()).send({ query, limit: 5 });

  let connectionId = '';

  it('a linked connection is never walked — syncing it is refused by name', async () => {
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'code_memory',
        sourceId: 'gitlab_issues',
        vertical: 'code',
        label: 'GitLab (asked, not copied)',
        mode: 'linked',
        config: { project: 'acme/handbook' },
        credential: 'glpat-linked',
      });
    expect(conn.status).toBe(201);
    connectionId = conn.body.id;
    expect(conn.body.mode).toBe('linked');
    const run = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(run.body.summary).toMatchObject({ status: 'skipped', skipped: 'linked_mode' });
    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?limit=10`)
      .set(auth());
    expect(items.body.items).toHaveLength(0);
  }, 60_000);

  it('a search asks it, and the answer rides beside the ranking, anchored', async () => {
    const res = await search('payments gateway webhook');
    expect(res.status).toBe(201);
    expect(res.body.linked).toHaveLength(1);
    const lane = res.body.linked[0];
    expect(lane).toMatchObject({ connectionId, connector: 'gitlab' });
    expect(lane.observationRef).toMatch(/^tool_observation:/);
    const titles = lane.hits.map((h: { title: string }) => h.title);
    expect(titles.join(' | ')).toContain('The payments gateway drops every third webhook');
    // The file matched too — both scopes are asked, interleaved.
    expect(titles.join(' | ')).toContain('payments.md');
    // The issue nobody asked about is not in the answer.
    expect(titles.join(' | ')).not.toContain('Warehouse sensors');
    // It is NOT memory: the brain's own ranking is untouched by it.
    expect(Array.isArray(res.body.results)).toBe(true);

    // The anchor exists, in this tenant, and is content-free.
    const obs = await rows<Record<string, unknown>>(
      `SELECT * FROM tool_observation ORDER BY createdAt DESC LIMIT 1`,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.tool).toBe('source_search.gitlab');
    expect(JSON.stringify(obs[0])).not.toContain('drops every third webhook');
  }, 60_000);

  it('the ref turns a hit into memory the ordinary way', async () => {
    const res = await search('payments gateway webhook');
    const lane = res.body.linked[0];
    const hit = lane.hits[0];
    const ingested = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'linked_source',
        text: `${hit.title}\n\n${hit.snippet ?? ''}`,
        originUri: hit.originUri,
        toolObservationRef: lane.observationRef,
        occurredAt: new Date().toISOString(),
        contextRef: { vertical: 'code' },
        storeContent: true,
        mode: 'sync',
      });
    expect([200, 201]).toContain(ingested.status);
    expect(ingested.body.documentId).toBeTruthy();
  }, 60_000);

  it('with the flag off nothing is asked and nothing is written', async () => {
    const before = (
      await rows<{ n: number }>(`SELECT count() AS n FROM tool_observation GROUP ALL`)
    )[0]?.n;
    process.env.SOURCE_LINKED = '0';
    try {
      const res = await search('payments gateway webhook');
      expect(res.body.linked).toBeUndefined();
      const after = (
        await rows<{ n: number }>(`SELECT count() AS n FROM tool_observation GROUP ALL`)
      )[0]?.n;
      expect(after).toBe(before);
    } finally {
      process.env.SOURCE_LINKED = '1';
    }
  }, 60_000);
});
