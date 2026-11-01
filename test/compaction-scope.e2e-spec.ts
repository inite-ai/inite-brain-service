/**
 * Compaction summaries, against a real SurrealDB: a retracted fact is
 * compacted but never retold (a summary of it served the retraction back
 * as active), and a team's facts roll up into a summary that carries the
 * team's tag — before, every summary was written with an empty scope and
 * read tenant-wide.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import { EmbedderService } from '../src/ai/embedder.service';
import { atWidth } from './test-doubles';

describe('compaction — retractions and scope (real SurrealDB)', () => {
  let f: AppFixture;
  const prev = process.env.COMPACTION_SUMMARIES;

  beforeAll(async () => {
    process.env.COMPACTION_SUMMARIES = '1';
    f = await createApp({ companyId: 'co_compaction_scope_e2e' });
  });

  afterAll(async () => {
    if (prev === undefined) delete process.env.COMPACTION_SUMMARIES;
    else process.env.COMPACTION_SUMMARIES = prev;
    if (f) await f.close();
  });

  it('summarises only what was true, under the scope it was read in', async () => {
    const surreal = f.app.get(SurrealService);
    const embedding = atWidth([0.1, 0.2], f.app.get(EmbedderService).primaryDimensions());
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE knowledge_entity:svc CONTENT { type: 'project', canonicalName: 'svc' }`,
      );
      const row = (pred: string, object: string, extra: string) =>
        db.query(
          `CREATE knowledge_fact CONTENT {
             entityId: knowledge_entity:svc, predicate: $p, object: $o, confidence: 0.9,
             validFrom: d'2024-01-01T00:00:00Z', validUntil: d'2024-02-01T00:00:00Z',
             recordedAt: d'2024-01-01T00:00:00Z', status: 'superseded', embedding: $v,
             source: { vertical: 'eng' } ${extra} }`,
          { p: pred, o: object, v: embedding },
        );
      await row('queue', 'redis', '');
      await row('queue', 'kafka', ", retractedAt: d'2024-01-15T00:00:00Z', status: 'retracted'");
      await row('queue', 'rabbit', '');
      await row('runbook', 'v1', ", scope: ['team:gl1:sre']");
      await row('runbook', 'v2', ", scope: ['team:gl1:sre']");
    });

    await f.app.get(CompactionRunnerService).compactCompany(f.companyId);

    const summaries = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ predicate: string; object: string; scope: string[] }>]
      >(
        `SELECT predicate, object, scope FROM knowledge_fact WHERE source.kind = 'compaction-summary'`,
      );
      return rows;
    });
    const queue = summaries.find((s) => s.predicate === 'summary_queue');
    expect(queue?.object).toContain('redis');
    expect(queue?.object).not.toContain('kafka');
    expect(summaries.find((s) => s.predicate === 'summary_runbook')?.scope).toEqual([
      'team:gl1:sre',
    ]);
  });
});
