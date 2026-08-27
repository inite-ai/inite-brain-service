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

describe('0111_tool_observation indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0111_tool_observation.surql'), 'utf8');

  it.each([
    ['tool_observation_created_idx', 'tool_observation', 'createdAt'],
    ['tool_observation_tool_idx', 'tool_observation', 'tool'],
    ['tool_observation_request_idx', 'tool_observation', 'requestId'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    const re = new RegExp(`DEFINE INDEX IF NOT EXISTS ${name}\\s+ON ${table} FIELDS ${fields};`);
    expect(sql).toMatch(re);
  });

  it('every index is SINGLE-FIELD (the 3.2.4 planner rule)', () => {
    // A compound index over this table would put its fields into the
    // DELETE-WHERE planner no-op class the prune's SELECT-ids shape
    // avoids — 0111 commits to single-field indexes only.
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
    }
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // The 0053/0107 separation rationale carries over: per-call
    // telemetry must not feed the audit mirror or any dirty-marking
    // event. The header EXPLAINS the absence in prose, so judge only
    // non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });
});

describe('0109_evidence_substrate indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0109_evidence_substrate.surql'), 'utf8');

  // ALL single-field, deliberately: compound coverage would put these
  // tables' delete paths (GDPR cascade + retention sweep) under the
  // 3.2.4 compound-planner DELETE no-op. byteHash UNIQUE doubles as the
  // 1:1 row↔blob invariant.
  it.each([
    ['evidence_asset_hash_idx', 'evidence_asset', 'byteHash UNIQUE'],
    ['evidence_asset_user_idx', 'evidence_asset', 'userId'],
    ['evidence_asset_avail_idx', 'evidence_asset', 'availability'],
    ['evidence_asset_retain_idx', 'evidence_asset', 'retainUntil'],
    ['evidence_fragment_asset_idx', 'evidence_fragment', 'assetId'],
    ['derived_repr_subject_idx', 'derived_representation', 'subjectId'],
    ['derived_repr_kind_idx', 'derived_representation', 'kind'],
    ['derived_repr_ver_idx', 'derived_representation', 'producerVersion'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('defines no compound index on any of the three tables', () => {
    const indexLines = sql
      .split('\n')
      .filter((l) => l.trimStart().startsWith('DEFINE INDEX'))
      .filter((l) => /evidence_asset|evidence_fragment|derived_representation/.test(l));
    for (const line of indexLines) {
      // A compound tuple would read `FIELDS a, b` — no comma may follow
      // the FIELDS clause outside the trailing UNIQUE/; suffix.
      expect(line).not.toMatch(/FIELDS [A-Za-z]+,/);
    }
  });

  it('deliberately defines NO changefeed and NO event on any table', () => {
    // Same GDPR reasoning as 0073/0106/0107: fragment labels + derived
    // caption/ocr/asr text must not stay readable in a feed after an
    // erasure. The header EXPLAINS the absence in prose, so judge only
    // non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('stamps the GDPR tombstone counters on forgotten_entity', () => {
    for (const field of [
      'evidenceAssetsDeleted',
      'evidenceFragmentsDeleted',
      'representationsDeleted',
    ]) {
      expect(sql).toContain(`DEFINE FIELD IF NOT EXISTS ${field} ON forgotten_entity`);
    }
  });
});

describe('evidence substrate DELETE-shape guards (0109)', () => {
  // The three tables sit on TWO delete paths; every delete must be the
  // two-step SELECT-ids → DELETE $ids idiom (the 3.2.4 planner no-op
  // class — see the suite below). A `DELETE <evidence table> WHERE`
  // anywhere in these writers is a regression.
  const files = [
    join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
    join(__dirname, '..', 'src', 'documents', 'candidate-sweeper.service.ts'),
    join(__dirname, '..', 'src', 'evidence', 'evidence-store.service.ts'),
  ];

  it('no writer uses a one-step DELETE-WHERE on the evidence tables', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/DELETE evidence_fragment WHERE/);
      expect(text).not.toMatch(/DELETE derived_representation WHERE/);
      expect(text).not.toMatch(/DELETE evidence_asset WHERE/);
    }
  });

  it('user-forget pre-collects the cascade ids (and blob refs) before deleting', () => {
    const src = readFileSync(files[0]!, 'utf8');
    expect(src).toContain(
      'LET $assetIds = (SELECT VALUE id FROM evidence_asset WHERE userId = $u)',
    );
    expect(src).toContain(
      'LET $fragIds = (SELECT VALUE id FROM evidence_fragment WHERE assetId INSIDE $assetIds)',
    );
    expect(src).toContain('LET $reprIds = (SELECT VALUE id FROM derived_representation');
    expect(src).toContain('DELETE $reprIds RETURN BEFORE');
    expect(src).toContain('DELETE $fragIds RETURN BEFORE');
    expect(src).toContain('DELETE $assetIds RETURN BEFORE');
    // Blob refs must be collected while the rows still exist.
    expect(src).toContain('SELECT VALUE storageRef FROM evidence_asset');
  });

  it('the retention sweep pre-collects fragment/representation ids per asset', () => {
    const src = readFileSync(files[2]!, 'utf8');
    expect(src).toContain('LET $fragIds = (SELECT VALUE id FROM evidence_fragment');
    expect(src).toContain('LET $reprIds = (SELECT VALUE id FROM derived_representation');
    expect(src).toContain('DELETE $fragIds RETURN BEFORE');
    expect(src).toContain('DELETE $reprIds RETURN BEFORE');
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
    // The two-step idiom now lives in ONE place (document-purge.util) —
    // every purge path delegates to it.
    const util = read('documents', 'document-purge.util.ts');
    expect(util).toContain('SELECT VALUE id FROM source_chunk');
    expect(util).toContain('DELETE $ids RETURN BEFORE');
    for (const file of [
      ['documents', 'candidate-sweeper.service.ts'],
      ['documents', 'document-store.service.ts'],
      ['documents', 'document-purge.util.ts'],
      ['entities', 'entity-forget.service.ts'],
      ['entities', 'user-forget.service.ts'],
    ]) {
      expect(read(...file)).not.toMatch(/DELETE source_chunk\s+WHERE/);
    }
  });

  it('forget document cascade: candidate/indexer_run/source_document go by pre-collected ids', () => {
    // candidate.docId and indexer_run.docId are record fields with
    // compound-index-adjacent coverage — the SurrealDB 3.2.4 DELETE
    // planner no-op shape. Every cascade delete must be the two-step
    // LET-select-ids → DELETE form.
    for (const file of [
      ['documents', 'document-purge.util.ts'],
      ['entities', 'entity-forget.service.ts'],
      ['entities', 'user-forget.service.ts'],
    ]) {
      const src = read(...file);
      expect(src).not.toMatch(/DELETE candidate\s+WHERE docId/);
      expect(src).not.toMatch(/DELETE indexer_run\s+WHERE/);
      expect(src).not.toMatch(/DELETE source_document\s+WHERE/);
    }
    const util = read('documents', 'document-purge.util.ts');
    const entityForget = read('entities', 'entity-forget.service.ts');
    for (const src of [util, entityForget]) {
      expect(src).toContain('SELECT VALUE id FROM candidate WHERE docId INSIDE');
      expect(src).toContain('SELECT VALUE id FROM indexer_run WHERE docId INSIDE');
    }
  });

  it('tool_observation prune (0111): bounded DELETE-subquery, never DELETE-WHERE', () => {
    const src = read('outcomes', 'outcome-prune.service.ts');
    expect(src).not.toMatch(/DELETE tool_observation\s+WHERE/);
    expect(src).toContain(
      'DELETE (SELECT id FROM tool_observation WHERE createdAt < $cutoff LIMIT 5000) RETURN BEFORE',
    );
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
