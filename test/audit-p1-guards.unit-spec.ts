/**
 * Wave P1 of the 2026-07 performance audit — regression guards.
 *
 * 1. Migration 0058 must gate every zombie-reap WHERE on
 *    `leaseUntil IS NOT NONE`: on SurrealDB 3.1.5 `NONE < time::now()`
 *    is TRUE, so without the gate the reaper flips lease-less inline
 *    job_run rows (manual dreams/reindex/refit) back to 'pending' and
 *    a queue worker starts a DUPLICATE execution.
 * 2. Migration 0059 must define the indexes the audit found missing.
 * 3. JobRunService.finish() must carry the inline-ownership guard so it
 *    can't clobber a row a queue worker has claimed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { JobRunService } from '../src/jobs/job-run.service';

const MIGRATIONS = join(__dirname, '..', 'src', 'db', 'migrations');

describe('0058_reap_zombies_lease_guard', () => {
  const sql = readFileSync(join(MIGRATIONS, '0058_reap_zombies_lease_guard.surql'), 'utf8');

  it('redefines fn::reap_zombies', () => {
    expect(sql).toContain('DEFINE FUNCTION OVERWRITE fn::reap_zombies');
  });

  it('gates every zombie WHERE on leaseUntil IS NOT NONE', () => {
    // Pre-select + requeue UPDATE + abandon UPDATE = 3 guarded clauses.
    // The UPDATE guards must stay byte-equal to the pre-select (0038
    // race-safety contract), so all three carry the same gate.
    const guarded = sql.match(
      /status = 'running' AND leaseUntil IS NOT NONE AND leaseUntil < \$now/g,
    );
    expect(guarded).toHaveLength(3);
    // No ungated `leaseUntil < $now` remains anywhere in the function
    // (comment lines excluded — the header explains the 0038 bug).
    const ungated = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .filter((l) => l.includes('leaseUntil < $now') && !l.includes('IS NOT NONE'));
    expect(ungated).toEqual([]);
  });
});

describe('0059_perf_indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0059_perf_indexes.surql'), 'utf8');

  it.each([
    ['fact_superseded_by_idx', 'knowledge_fact', 'supersededBy'],
    ['fact_derived_from_idx', 'knowledge_fact', 'derivedFrom'],
    ['fact_retracted_idx', 'knowledge_fact', 'retractedAt'],
    ['fact_valid_until_idx', 'knowledge_fact', 'validUntil'],
    ['retrieval_feedback_created_idx', 'retrieval_feedback', 'createdAt'],
    ['edge_invalidated_idx', 'knowledge_edge', 'invalidatedAt'],
  ])('defines %s on %s(%s)', (name, table, field) => {
    const re = new RegExp(`DEFINE INDEX IF NOT EXISTS ${name}\\s+ON ${table} FIELDS ${field};`);
    expect(sql).toMatch(re);
  });
});

describe('0106_memory_episode indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0106_memory_episode.surql'), 'utf8');

  it.each([
    ['scene_version_idx', 'memory_episode', 'segmenterVersion'],
    ['scene_conv_idx', 'memory_episode', 'conversationIds'],
    ['scene_user_idx', 'memory_episode', 'userId'],
    ['scene_time_idx', 'memory_episode', 'occurredFrom'],
    ['scene_member_uq', 'memory_episode_member', 'in, out UNIQUE'],
    ['scene_member_out_idx', 'memory_episode_member', 'out'],
    ['scene_member_ver_idx', 'memory_episode_member', 'segmenterVersion'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('defines the BM25 gist index with the lowercase-only analyzer', () => {
    expect(sql).toContain(
      'DEFINE ANALYZER IF NOT EXISTS scene_gist TOKENIZERS class FILTERS lowercase;',
    );
    expect(sql).toMatch(
      /DEFINE INDEX IF NOT EXISTS scene_gist_search ON memory_episode\s+FIELDS gist FULLTEXT ANALYZER scene_gist BM25;/,
    );
  });
});

describe('entity-forget scenes cascade (0106)', () => {
  // Source-regex guard, same spirit as the index tuples above: the atomic
  // erase transaction must take scene membership AND scene rows with the
  // episodes it deletes — dropping either line reopens the GDPR hole that
  // audit W1 #13 closed for segments.
  const src = readFileSync(
    join(__dirname, '..', 'src', 'entities', 'entity-forget.service.ts'),
    'utf8',
  );

  it('the erase transaction deletes scene membership and scenes', () => {
    // Two-step (SELECT ids → DELETE $ids): on SurrealDB 3.2.4 a DELETE
    // whose WHERE filters on `in` (compound scene_member_uq coverage)
    // silently matches NOTHING — the membership erase must go by ids.
    expect(src).toContain(
      'LET $sceneMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $sceneIds)',
    );
    expect(src).toContain('DELETE $sceneMemberIds');
    expect(src).toContain('DELETE memory_episode WHERE id INSIDE $sceneIds');
    // Scene resolution must come from membership of the dying episodes.
    expect(src).toContain('SELECT VALUE in FROM memory_episode_member WHERE out INSIDE $eps');
  });

  it('no writer uses the 3.2.4-broken DELETE-on-`in` shape', () => {
    // Regression guard for the silent-no-op class: `DELETE
    // memory_episode_member WHERE in ...` (traversal OR direct INSIDE)
    // matches nothing on the pinned server because `in` is covered only
    // by the COMPOUND scene_member_uq index. Every membership delete
    // must be the two-step SELECT-ids → DELETE $ids idiom.
    const files = [
      join(__dirname, '..', 'src', 'entities', 'entity-forget.service.ts'),
      join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
      join(__dirname, '..', 'src', 'admin', 'scene-composer.service.ts'),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/DELETE memory_episode_member WHERE in[\s.]/);
    }
  });
});

describe('0107_memory_outcome indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0107_memory_outcome.surql'), 'utf8');

  it.each([
    ['memory_outcome_subject_idx', 'memory_outcome', 'subjectId, event'],
    ['memory_outcome_created_idx', 'memory_outcome', 'createdAt'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    const re = new RegExp(`DEFINE INDEX IF NOT EXISTS ${name}\\s+ON ${table} FIELDS ${fields};`);
    expect(sql).toMatch(re);
  });

  it('pins the rollup to one row per subject (UNIQUE subjectId)', () => {
    expect(sql).toMatch(
      /DEFINE INDEX IF NOT EXISTS memory_outcome_stat_subject_idx\s+ON memory_outcome_stat FIELDS subjectId UNIQUE;/,
    );
  });

  it('deliberately defines NO changefeed and NO event on either table', () => {
    // The 0053 separation rationale: telemetry must not feed the audit
    // mirror or any dirty-marking event. The header EXPLAINS the absence
    // in prose, so judge only non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });
});

describe('SurrealDB 3.2.4 DELETE-WHERE planner no-op guards', () => {
  // Bug class (reproduced against the pinned surrealdb/surrealdb:v3.2.4,
  // rocksdb, WS driver with CBOR binds AND HTTP /sql): a `DELETE <table>
  // WHERE <predicate>` can silently match NOTHING (returns OK, deletes
  // zero rows) while a SELECT with the identical WHERE matches — when the
  // filtered field's index coverage includes a COMPOUND index, or when
  // the WHERE traverses a record field into an indexed target field.
  // Every such statement must use the two-step SELECT-ids → DELETE $ids
  // idiom (see preSweepOutcomeRows, PR #372). These guards pin the fixed
  // files so the one-step shapes cannot regress.
  const SRC = join(__dirname, '..', 'src');
  const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

  it('user-forget: retrieval_feedback / knowledge_edge / knowledge_artifact go by ids', () => {
    const src = read('entities', 'user-forget.service.ts');
    // Reproduced no-op: traversal through compound-covered factId.
    expect(src).not.toMatch(/DELETE retrieval_feedback WHERE/);
    expect(src).toContain('SELECT VALUE id FROM retrieval_feedback WHERE factId.userId = $u');
    // Defensive: in.userId/out.userId traverse compound-covered fields.
    expect(src).not.toMatch(/DELETE knowledge_edge\s+WHERE/);
    expect(src).toContain('SELECT VALUE id FROM knowledge_edge');
    // Defensive: entityId covered only by the COMPOUND artifact index.
    expect(src).not.toMatch(/DELETE knowledge_artifact\s+WHERE/);
    expect(src).toContain('SELECT VALUE id FROM knowledge_artifact');
  });

  it('entity-forget tx: retrieval_feedback / knowledge_artifact go by pre-collected ids', () => {
    const src = read('entities', 'entity-forget.service.ts');
    expect(src).not.toMatch(/DELETE retrieval_feedback WHERE/);
    expect(src).toContain(
      "SELECT VALUE id FROM retrieval_feedback WHERE factId.entityId = type::record('knowledge_entity', $rid)",
    );
    expect(src).toContain('DELETE $feedbackIds');
    expect(src).not.toMatch(/DELETE knowledge_artifact WHERE/);
    expect(src).toContain(
      "SELECT VALUE id FROM knowledge_artifact WHERE entityId = type::record('knowledge_entity', $rid)",
    );
    expect(src).toContain('DELETE $artifactIds');
  });

  it('digest writers: no DELETE conversation_digest filtered on the compound pair', () => {
    // (conversationId, derivedVersion) is exactly digest_conv_version_idx
    // UNIQUE — the risky compound shape. The version-only DELETEs
    // (second field of the compound, planner cannot use it) stay.
    const digestPersist = read('admin', 'digest-persist.ts');
    expect(digestPersist).not.toMatch(/DELETE conversation_digest\s+WHERE conversationId/);
    expect(digestPersist).toContain('SELECT VALUE id FROM conversation_digest');
    const staging = read('admin', 'derive-staging.ts');
    expect(staging).not.toMatch(
      /DELETE conversation_digest\s+WHERE derivedVersion = \$final AND conversationId/,
    );
    expect(staging).toContain('LET $digestIds = (SELECT VALUE id FROM conversation_digest');
    expect(staging).toContain('DELETE $digestIds');
  });

  it('source_chunk purges: no DELETE filtered on compound-only docId', () => {
    // docId is covered ONLY by source_chunk_doc_idx (docId, seq) UNIQUE.
    for (const file of [
      ['documents', 'candidate-sweeper.service.ts'],
      ['documents', 'document-store.service.ts'],
    ]) {
      const src = read(...file);
      expect(src).not.toMatch(/DELETE source_chunk WHERE/);
      expect(src).toContain('SELECT VALUE id FROM source_chunk');
      expect(src).toContain('DELETE $ids RETURN BEFORE');
    }
  });
});

describe('JobRunService.finish ownership guard', () => {
  function mkSurreal(db: { query: (s: string, p?: any) => Promise<any> }) {
    return {
      withCompany: async <T>(_c: string, fn: (d: any) => Promise<T>) => fn(db),
    } as any;
  }

  it('only finishes rows still running and unclaimed', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        return [[]];
      },
    };
    const svc = new JobRunService(mkSurreal(db));
    const row = await svc.start({
      jobType: 'dreams',
      companyId: 'co_x',
      triggeredBy: 'manual',
    });
    await svc.finish(row, { status: 'succeeded' });

    const finishSql = calls.find((s) => s.includes('UPDATE job_run SET'));
    expect(finishSql).toBeDefined();
    expect(finishSql).toContain(`status = 'running'`);
    expect(finishSql).toContain('claimedBy IS NONE');
  });
});
