/**
 * Public episodes API (raw-substrate driver v1, surface 1) — e2e on a
 * real DB. Episodes land through episode-only ingest (no LLM), then:
 * flag gate (off → 404), keyset pagination (stable order, cursor
 * resumes, no skips/repeats), filters, the PII fence (no
 * brain:read_pii → piiClass rows invisible), and the NDJSON export.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('episodes API (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ['EPISODE_SUBSTRATE_ENABLED', 'INGEST_EPISODE_ONLY', 'EPISODES_API_ENABLED']) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
    f = await createApp({
      companyId: 'co_episodes_api_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:read_pii'],
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    // Five plain turns + one carrying PII (an email address).
    const turns = [
      { t: '2026-01-01T10:00:00.000Z', text: 'Started the budget tracker.' },
      { t: '2026-01-02T10:00:00.000Z', text: 'Added transaction parsing.' },
      { t: '2026-01-03T10:00:00.000Z', text: 'Fixed the rounding bug.' },
      { t: '2026-01-04T10:00:00.000Z', text: 'Deployed the first beta.' },
      { t: '2026-01-05T10:00:00.000Z', text: 'Collected user feedback.' },
      {
        t: '2026-01-06T10:00:00.000Z',
        text: 'Reach me at pii.probe@example.com for details.',
      },
    ];
    for (const [i, turn] of turns.entries()) {
      const res = await f.http
        .post('/v1/ingest/mention')
        .set(auth())
        .send({
          text: turn.text,
          contextRef: {
            vertical: 'proj',
            conversationId: 'proj:tracker',
            messageId: `m${i}`,
          },
          knownEntities: [{ vertical: 'proj', id: 'mika', role: 'speaker', name: 'mika' }],
          emittedAt: turn.t,
        });
      expect(res.status).toBe(201);
    }
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('answers 404 with the flag off', async () => {
    delete process.env.EPISODES_API_ENABLED;
    const res = await f.http.get('/v1/episodes').set(auth());
    expect(res.status).toBe(404);
    process.env.EPISODES_API_ENABLED = '1';
  });

  it('pages in (occurredAt, id) order and the cursor resumes without gaps', async () => {
    const p1 = await f.http.get('/v1/episodes?limit=4').set(auth());
    expect(p1.status).toBe(200);
    expect(p1.body.episodes).toHaveLength(4);
    expect(p1.body.nextCursor).toBeDefined();
    const p2 = await f.http
      .get(`/v1/episodes?limit=4&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set(auth());
    expect(p2.status).toBe(200);
    const texts = [...p1.body.episodes, ...p2.body.episodes].map((e: { text: string }) => e.text);
    expect(texts).toHaveLength(6);
    expect(new Set(texts).size).toBe(6); // no repeats across pages
    const dates = [...p1.body.episodes, ...p2.body.episodes].map(
      (e: { occurredAt: string }) => e.occurredAt,
    );
    expect([...dates].sort()).toEqual(dates); // globally ordered
    expect(p2.body.nextCursor).toBeUndefined();
    // Wire shape: record id stringified, ISO datetimes, source object.
    const first = p1.body.episodes[0];
    expect(String(first.id)).toMatch(/^episode:/);
    expect(first.messageId).toBe('m0');
    expect(first.source.vertical).toBe('proj');
  });

  it('filters by time range', async () => {
    const res = await f.http
      .get('/v1/episodes?since=2026-01-03T00:00:00Z&until=2026-01-04T23:59:59Z')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.episodes.map((e: { text: string }) => e.text)).toEqual([
      'Fixed the rounding bug.',
      'Deployed the first beta.',
    ]);
  });

  it('rejects malformed cursor and dates', async () => {
    expect((await f.http.get('/v1/episodes?cursor=%3F%3F').set(auth())).status).toBe(400);
    expect((await f.http.get('/v1/episodes?since=yesterday').set(auth())).status).toBe(400);
  });

  it('hides piiClass rows from callers without brain:read_pii', async () => {
    const all = await f.http.get('/v1/episodes?limit=100').set(auth());
    const withPii = all.body.episodes.filter((e: { piiClass?: string[] }) => e.piiClass?.length);
    // The email turn must exist and be classed for the fence to mean
    // anything — guard the precondition, don't assume it.
    expect(withPii.length).toBeGreaterThan(0);

    const res = await f.http.get('/v1/episodes?limit=100').set({
      Authorization: `Bearer ${f.extraApiKeys[0]}`,
    });
    expect(res.status).toBe(200);
    const texts = res.body.episodes.map((e: { text: string }) => e.text);
    expect(texts).toHaveLength(6 - withPii.length);
    expect(texts.join(' ')).not.toContain('example.com');
  });

  it('exports the same fenced stream as NDJSON', async () => {
    const res = await f.http.get('/v1/episodes/export').set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(6);
    const rows = lines.map((l) => JSON.parse(l) as { occurredAt: string });
    const dates = rows.map((r) => r.occurredAt);
    expect([...dates].sort()).toEqual(dates);
  });
});
