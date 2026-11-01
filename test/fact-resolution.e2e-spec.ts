/**
 * Fact resolution (#828) against a REAL SurrealDB, through the harness
 * work path (take → verdicts → submit): the candidate scan, the
 * valid-time precedence of `replaces` whichever fact arrived first, the
 * `contradicts` write, and a stale submit. The judge's prompt and verdict
 * parsing are covered by test/fact-resolution.unit-spec.ts.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FactResolutionService } from '../src/dreams/fact-resolution.service';
import { verifyWorkToken, type ResolutionTokenPayload } from '../src/common/harness-work-token';

describe('fact resolution — take, judge, apply (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_fact_resolution_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (subject: string, predicate: string, object: string, validFrom: string) => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'eng', id: subject },
        predicate,
        object,
        validFrom,
        confidence: 0.9,
        source: { vertical: 'eng', recorder: 'e2e' },
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  const row = async (id: string) =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ status: string; validUntil?: unknown; resolutionCheckedAt?: unknown }>]
      >(`SELECT status, validUntil, resolutionCheckedAt FROM type::record('knowledge_fact', $t)`, {
        t: id.split(':')[1],
      });
      return rows[0]!;
    });

  /** Take one batch and answer every candidate of every item with `verdict`. */
  const judgeAll = async (verdict: string) => {
    const svc = f.app.get(FactResolutionService);
    const work = await svc.take(f.companyId);
    expect(work).not.toBeNull();
    const v = verifyWorkToken(work!.token);
    expect(v.state).toBe('valid');
    const payload = (v as { payload: ResolutionTokenPayload }).payload;
    const result = {
      items: payload.f.map(([, candidates], i) => ({
        item: `r${i + 1}`,
        verdicts: candidates.map((_, j) => ({ candidate: `c${j + 1}`, verdict })),
      })),
    };
    return { svc, payload, result };
  };

  it('replaces: the earlier-valid value closes at the later one, though it arrived last', async () => {
    // The newer value is written first; the older one arrives later under another name.
    const fargate = await ingest('svc_a', 'deploy_target', 'AWS ECS Fargate', '2026-03-25');
    const fly = await ingest('svc_a', 'deployed_to', 'Fly.io', '2026-03-02');
    const { svc, payload, result } = await judgeAll('replaces');
    await svc.submit(f.companyId, payload, result);

    const old = await row(fly);
    expect(old.status).toBe('superseded');
    expect(String(old.validUntil)).toContain('2026-03-25');
    expect((await row(fargate)).status).toBe('active');
    expect(
      (await row(fly)).resolutionCheckedAt ?? (await row(fargate)).resolutionCheckedAt,
    ).toBeDefined();
  });

  it('contradicts: both stand, competing', async () => {
    const a = await ingest('svc_b', 'payout_cutoff', '17:00 UTC', '2026-03-10');
    const b = await ingest('svc_b', 'cutoff_time', '16:30 UTC', '2026-03-10');
    const { svc, payload, result } = await judgeAll('contradicts');
    await svc.submit(f.companyId, payload, result);
    expect((await row(a)).status).toBe('competing');
    expect((await row(b)).status).toBe('competing');

    // 0175: the two share no slot — only the link keeps them rivals, and
    // when one leaves the other is current again.
    await f.app
      .get(SurrealService)
      .withCompany(f.companyId, (db) =>
        db.query(
          `UPDATE type::record('knowledge_fact', $t) SET status = 'retracted', retractedAt = time::now()`,
          { t: b.split(':')[1] },
        ),
      );
    expect((await row(a)).status).toBe('active');
  });

  it('same: a paraphrase that competed with the incumbent corroborates it, and the incumbent is current again', async () => {
    // fn::resolve_fact marks a reworded value competing by a score margin.
    const incumbent = await ingest('svc_d', 'admin_console_port', '8081', '2026-03-25');
    const paraphrase = await ingest(
      'svc_d',
      'admin_port',
      '8081 (internal admin console)',
      '2026-03-25',
    );
    await f.app.get(SurrealService).withCompany(f.companyId, (db) =>
      db.query(
        `UPDATE type::record('knowledge_fact', $p) SET status = 'competing',
           conflictTrace = { bestOpponentId: type::record('knowledge_fact', $i) };
         UPDATE type::record('knowledge_fact', $i) SET status = 'competing';`,
        { p: paraphrase.split(':')[1], i: incumbent.split(':')[1] },
      ),
    );
    const { svc, payload, result } = await judgeAll('same');
    await svc.submit(f.companyId, payload, result);
    expect((await row(paraphrase)).status).toBe('corroborating');
    expect((await row(incumbent)).status).toBe('active');
  });

  it('a reply to evidence that changed since is skipped as stale', async () => {
    await ingest('svc_c', 'retry_policy', 'fixed 3 x 30s', '2026-03-02');
    const changed = await ingest('svc_c', 'retries', 'exponential backoff', '2026-03-18');
    const { svc, payload, result } = await judgeAll('replaces');
    await f.app.get(SurrealService).withCompany(f.companyId, (db) =>
      db.query(`UPDATE type::record('knowledge_fact', $t) SET object = 'linear backoff'`, {
        t: changed.split(':')[1],
      }),
    );
    const out = await svc.submit(f.companyId, payload, result);
    expect(out.stale).toBeGreaterThan(0);
  });

  it('a fact said in a trust circle is never judged against one outside it (the 0172 pool)', async () => {
    const inCircle = await ingest('svc_e', 'deploy_target', 'Hetzner', '2026-03-02');
    const outside = await ingest('svc_e', 'deployed_to', 'Render', '2026-03-03');
    await f.app.get(SurrealService).withCompany(f.companyId, (db) =>
      db.query(`UPDATE type::record('knowledge_fact', $t) SET scope = ['circle:ops']`, {
        t: inCircle.split(':')[1],
      }),
    );
    const svc = f.app.get(FactResolutionService);
    const work = await svc.take(f.companyId);
    const tuples = work
      ? (verifyWorkToken(work.token) as { payload: ResolutionTokenPayload }).payload.f
      : [];
    for (const [fact, candidates] of tuples) {
      if (fact === inCircle) expect(candidates).not.toContain(outside);
      if (fact === outside) expect(candidates).not.toContain(inCircle);
    }
    // With no candidate in its own pool, each is marked judged at once.
    expect((await row(inCircle)).resolutionCheckedAt).toBeDefined();
    expect((await row(outside)).resolutionCheckedAt).toBeDefined();
  });
});
