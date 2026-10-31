/**
 * Read fences on two surfaces that dropped the per-user scope, against a
 * REAL SurrealDB:
 *  - REST `GET /v1/entities/:id` now binds `?userId=` (the timeline and
 *    connections routes already did): a personal fact reaches the
 *    profile only for its user, and never without one;
 *  - `recall_decisions` (CodeMemorySearchService.recall) reads through
 *    the same user fence: a personal code-memory decision is recalled
 *    for its user only — before, its cosine scan had no user filter;
 *  - a fact with no user written under an org connection's `team:`
 *    scope carries it (before, only a personal fact was stamped, so a
 *    private repository's facts were tenant-global).
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { CodeMemorySearchService } from '../src/code-memory/code-memory-search.service';
import { IngestService } from '../src/ingest/ingest.service';
import { runWithWriteScope } from '../src/auth/write-scope';
import type { IngestFactDto } from '../src/ingest/dto/ingest-fact.dto';

describe('read fences — REST profile userId, recall_decisions (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_read_fences_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const ingest = async (predicate: string, object: string, userId?: string) => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'eng', id: 'svc_fence' },
        predicate,
        object,
        validFrom: '2026-03-02',
        confidence: 0.9,
        source: { vertical: 'eng', recorder: 'e2e' },
        ...(userId ? { userId } : {}),
      });
    expect([200, 201]).toContain(res.status);
    return res.body.factId as string;
  };

  const entityOf = (factId: string) =>
    f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[string[]]>(
        `SELECT VALUE <string> entityId FROM type::record('knowledge_fact', $t)`,
        { t: factId.split(':')[1] },
      );
      return rows[0]!;
    });

  it('REST profile: a personal fact appears only with its userId', async () => {
    const shared = await ingest('runtime', 'Node 22');
    await ingest('editor_preference', 'neovim', 'u_fence');
    const entityId = await entityOf(shared);

    const without = await f.http.get(`/v1/entities/${entityId}`).set(auth());
    expect(without.status).toBe(200);
    const objects = (r: { body: { facts: Array<{ object: string }> } }) =>
      r.body.facts.map((x) => x.object);
    expect(objects(without)).toContain('Node 22');
    expect(objects(without)).not.toContain('neovim');

    const mine = await f.http.get(`/v1/entities/${entityId}?userId=u_fence`).set(auth());
    expect(objects(mine)).toEqual(expect.arrayContaining(['Node 22', 'neovim']));

    const other = await f.http.get(`/v1/entities/${entityId}?userId=u_other`).set(auth());
    expect(objects(other)).not.toContain('neovim');
  });

  it('recall_decisions: a personal decision is recalled for its user only', async () => {
    const text = 'retries carry an idempotency key because duplicate payouts happened';
    await ingest('code_memory__because', text, 'u_fence');
    const recall = f.app.get(CodeMemorySearchService);
    const base = { companyId: f.companyId, query: text, scopes: ['brain:read' as const] };

    const tenant = await recall.recall(base);
    expect(tenant.map((d) => d.text)).not.toContain(text);

    const mine = await recall.recall({ ...base, userId: 'u_fence' });
    expect(mine.map((d) => d.text)).toContain(text);

    const other = await recall.recall({ ...base, userId: 'u_other' });
    expect(other.map((d) => d.text)).not.toContain(text);
  });

  it("a fact with no user written under a team scope carries the team's tag", async () => {
    const team = 'team:gl1:eng';
    const dto = {
      entityRef: { vertical: 'eng', id: 'svc_private' },
      predicate: 'deploy_target',
      object: 'internal k8s',
      validFrom: '2026-03-02',
      confidence: 0.9,
      source: { vertical: 'eng', recorder: 'e2e' },
    } as unknown as IngestFactDto;
    const out = await runWithWriteScope([team], () =>
      f.app.get(IngestService).ingestFact(f.companyId, dto),
    );
    const factId = String((out as { factId: string }).factId);
    const scope = await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[string[][]]>(
        `SELECT VALUE scope FROM type::record('knowledge_fact', $t)`,
        { t: factId.split(':')[1] },
      );
      return rows[0];
    });
    expect(scope).toEqual([team]);
  });
});
