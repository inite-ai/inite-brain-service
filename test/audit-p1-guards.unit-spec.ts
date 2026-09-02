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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { JobRunService } from '../src/jobs/job-run.service';
import {
  DERIVED_REPRESENTATION_KINDS,
  EVIDENCE_MODALITIES,
  PROCESSING_RUN_STATUSES,
  QUARANTINE_STATUSES,
} from '../src/common/evidence-taxonomy';

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
      join(__dirname, '..', 'src', 'documents', 'scene-candidate-writer.service.ts'),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/DELETE memory_episode_member WHERE in[\s.]/);
    }
  });
});

describe('0110_candidate_scene_kinds (pack memory projections)', () => {
  const sql = readFileSync(join(MIGRATIONS, '0110_candidate_scene_kinds.surql'), 'utf8');

  it('widens the candidate kind enum via OVERWRITE (IF NOT EXISTS is a no-op on 3.x)', () => {
    expect(sql).toContain('DEFINE FIELD OVERWRITE kind ON candidate TYPE string');
    expect(sql).toContain(
      "ASSERT $value INSIDE ['entity','fact','relation','scene','state_delta']",
    );
  });

  it('defines the doc-scene tombstone counter for the forget doc-cascade', () => {
    expect(sql).toContain(
      'DEFINE FIELD IF NOT EXISTS purgedDocScenes ON forgotten_entity TYPE option<int>;',
    );
  });

  it('deliberately defines NO index, NO changefeed and NO event', () => {
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/DEFINE INDEX/);
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('the forget doc-cascade erases doc-derived scene projections by pre-collected ids', () => {
    // Source-regex guard (the entity-forget scenes cascade mold): a
    // memory_episode row projected from a document is keyed by
    // source.docId, NOT by memory_episode_member — the membership leg
    // cannot reach it. LET-select-ids → DELETE, never DELETE…WHERE on
    // the compound-index-covered shapes (3.2.4 planner no-op), and never
    // behind PACK_MEMORY_PROJECTIONS_ENABLED (unconditional erasure).
    const src = readFileSync(
      join(__dirname, '..', 'src', 'entities', 'entity-forget.service.ts'),
      'utf8',
    );
    expect(src).toContain(
      'LET $docSceneIds = (SELECT VALUE id FROM memory_episode WHERE source.docId INSIDE $purgeDocs)',
    );
    expect(src).toContain(
      'LET $docSceneMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $docSceneIds)',
    );
    expect(src).toContain('DELETE $docSceneMemberIds');
    expect(src).toContain('LET $docScenesDel = (DELETE $docSceneIds RETURN BEFORE)');
    expect(src).toContain('purgedDocScenes: array::len($docScenesDel)');
    expect(src).not.toMatch(/packMemoryProjectionsEnabled/);
  });

  it('the scene-candidate writer swaps by pre-collected ids (3.2.4 planner shape)', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'documents', 'scene-candidate-writer.service.ts'),
      'utf8',
    );
    expect(src).toContain(
      'LET $oldMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $oldIds)',
    );
    expect(src).toContain('DELETE $oldMemberIds');
    expect(src).toContain('DELETE memory_episode WHERE id INSIDE $oldIds');
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

describe('0119_decision_telemetry', () => {
  const sql = readFileSync(join(MIGRATIONS, '0119_decision_telemetry.surql'), 'utf8');

  it.each([
    ['memory_decision_id_idx', 'memory_decision', 'decisionId'],
    ['memory_decision_created_idx', 'memory_decision', 'createdAt'],
    ['memory_decision_request_idx', 'memory_decision', 'requestId'],
    ['memory_outcome_decision_idx', 'memory_outcome', 'decisionId'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    const re = new RegExp(`DEFINE INDEX IF NOT EXISTS ${name}\\s+ON ${table} FIELDS ${fields};`);
    expect(sql).toMatch(re);
  });

  it('adds the decisionId join column to BOTH memory_outcome and focus_signal_sample', () => {
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS decisionId ON memory_outcome');
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS decisionId ON focus_signal_sample');
  });

  it('every index is SINGLE-FIELD and NON-UNIQUE (idempotency = record id, 3.2.4 planner rule)', () => {
    // A UNIQUE index over an option<string> column would collide across
    // every legacy NONE row (the 0119 header) — uniqueness must stay in
    // the deterministic record id; compound coverage would put the GDPR
    // join-purge / prune deletes into the 3.2.4 planner no-op class.
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
      expect(def).not.toContain('UNIQUE');
    }
  });

  it('deliberately defines NO changefeed and NO event', () => {
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });
});

describe('memory_decision GDPR join-purge (0119)', () => {
  // Decision rows carry NO subject/user linkage by design — both forget
  // services must resolve them THROUGH the subject's outcome rows
  // (memory_outcome.decisionId) BEFORE those rows die, with the two-step
  // LET-select → DELETE-by-ids idiom (the 3.2.4 planner no-op class).
  const entitySrc = readFileSync(
    join(__dirname, '..', 'src', 'entities', 'entity-forget.service.ts'),
    'utf8',
  );
  const userSrc = readFileSync(
    join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
    'utf8',
  );

  it('entity-forget: pre-sweep AND in-tx legs collect keys through the outcome join', () => {
    // Pre-sweep leg (before the bulk outcome purge deletes the join rows).
    expect(entitySrc).toContain(
      'LET $decKeys = array::distinct((SELECT VALUE decisionId FROM memory_outcome',
    );
    // In-tx straggler leg, keyed on the subject.
    expect(entitySrc).toContain(
      'LET $decKeys = (SELECT VALUE decisionId FROM memory_outcome WHERE subjectId.entityId = $ent AND decisionId IS NOT NONE)',
    );
    expect(entitySrc).toContain(
      'LET $decIds = (SELECT VALUE id FROM memory_decision WHERE decisionId INSIDE $decKeys)',
    );
    expect(entitySrc).toContain('DELETE $decIds');
  });

  it('user-forget: decisions go FIRST, through the user-scoped outcome join', () => {
    expect(userSrc).toContain(
      'LET $decKeys = array::distinct((SELECT VALUE decisionId FROM memory_outcome',
    );
    expect(userSrc).toContain('subjectId.userId = $u AND decisionId IS NOT NONE');
    expect(userSrc).toContain(
      'LET $decIds = (SELECT VALUE id FROM memory_decision WHERE decisionId INSIDE $decKeys)',
    );
    expect(userSrc).toContain('DELETE $decIds');
    // Ordering is load-bearing: the join keys must be collected while the
    // outcome rows are alive — decisions before outcomes in the block.
    expect(userSrc.indexOf('DELETE $decIds')).toBeLessThan(userSrc.indexOf('DELETE $outIds'));
  });

  it('no writer uses a one-step DELETE-WHERE on memory_decision', () => {
    for (const src of [
      entitySrc,
      userSrc,
      readFileSync(join(__dirname, '..', 'src', 'outcomes', 'outcome-prune.service.ts'), 'utf8'),
      readFileSync(join(__dirname, '..', 'src', 'outcomes', 'memory-decision.service.ts'), 'utf8'),
    ]) {
      expect(src).not.toMatch(/DELETE memory_decision\s+WHERE/);
    }
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

  it('pins migration enums to the canonical TS Evidence Plane taxonomy', () => {
    const modalityAssert = /modality ON evidence_asset[^;]*ASSERT[^;]*;/s.exec(sql)?.[0] ?? '';
    const representationAssert =
      /kind ON derived_representation[^;]*ASSERT[^;]*;/s.exec(sql)?.[0] ?? '';
    const values = (statement: string) =>
      [...statement.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(values(modalityAssert)).toEqual([...EVIDENCE_MODALITIES]);
    expect(values(representationAssert)).toEqual([...DERIVED_REPRESENTATION_KINDS]);
  });
});

describe('0114 evidence blob-GC outbox', () => {
  const sql = readFileSync(join(MIGRATIONS, '0114_evidence_blob_gc.surql'), 'utf8');

  it('keeps hard-erasure blob deletion durable without a changefeed copy', () => {
    expect(sql).toContain('DEFINE TABLE IF NOT EXISTS evidence_blob_gc SCHEMAFULL;');
    expect(sql).toContain(
      'DEFINE INDEX IF NOT EXISTS evidence_blob_gc_ref_idx ON evidence_blob_gc FIELDS storageRef;',
    );
    const code = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED|DEFINE EVENT/);
  });

  it('user-forget enqueues refs before deleting evidence rows', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
      'utf8',
    );
    expect(src.indexOf('INSERT INTO evidence_blob_gc')).toBeLessThan(
      src.indexOf('DELETE $assetIds RETURN BEFORE'),
    );
    expect(src).toContain('queued for durable retry');
  });
});

describe('0122_evidence_grant indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0122_evidence_grant.surql'), 'utf8');

  // ALL single-field, deliberately: this table sits on BOTH delete paths
  // (GDPR user-forget + retention sweep), and compound coverage would put
  // assetId under the 3.2.4 compound-planner DELETE no-op. No UNIQUE
  // (assetId, ownerKind, ownerId) natural key — dedup lives at the write
  // seam (EvidenceStoreService.addGrant), the 0109 fragment precedent.
  it.each([
    ['evidence_grant_asset_idx', 'evidence_grant', 'assetId'],
    ['evidence_grant_owner_idx', 'evidence_grant', 'ownerId'],
    ['evidence_grant_kind_idx', 'evidence_grant', 'ownerKind'],
    ['evidence_grant_revoked_idx', 'evidence_grant', 'revokedAt'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('every index is SINGLE-FIELD (the 3.2.4 planner rule)', () => {
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
      expect(fields).not.toContain('UNIQUE');
    }
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // A grant row names a principal; a 30-day feed would keep GDPR-erased
    // ownership readable after the rows die (0109/0114 reasoning). The
    // header EXPLAINS the absence in prose, so judge only non-comment
    // lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('stamps the GDPR tombstone counter on forgotten_entity', () => {
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS evidenceGrantsDeleted ON forgotten_entity');
  });

  it('backfills legacy-owned assets idempotently (grant-less assets only)', () => {
    // The FOR-loop must guard each CREATE on the asset having ZERO grant
    // rows — a re-applied migration (or crash-retry) must not duplicate.
    // LET-then-FOR: on the pinned 3.2.4 a FOR over an inline SELECT
    // subquery fails ("Cannot execute statement using value: NONE");
    // iterating a LET-bound variable is the working fn::resolve_fact
    // idiom.
    expect(sql).toContain(
      'LET $legacyOwned = (SELECT id, userId, createdAt FROM evidence_asset WHERE userId != NONE);',
    );
    expect(sql).toContain('FOR $a IN $legacyOwned {');
    // The header EXPLAINS the broken shape in prose — judge only code.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/FOR \$a IN \(SELECT/);
    expect(sql).toMatch(
      /IF array::len\(\(SELECT VALUE id FROM evidence_grant WHERE assetId = \$a\.id\)\) = 0/,
    );
    expect(sql).toContain("ownerKind: 'user'");
  });
});

describe('0125_evidence_access (raw-read gateway audit)', () => {
  const sql = readFileSync(join(MIGRATIONS, '0125_evidence_access.surql'), 'utf8');

  // ALL single-field, deliberately: the table sits on the GDPR delete
  // path (rows die with their asset in user-forget AND in the retention/
  // quarantine tombstone path) — compound coverage would put assetId
  // under the 3.2.4 compound-planner DELETE no-op (0122 reasoning).
  it.each([
    ['evidence_access_asset_idx', 'evidence_access', 'assetId'],
    ['evidence_access_key_idx', 'evidence_access', 'keyHash'],
    ['evidence_access_created_idx', 'evidence_access', 'createdAt'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('every index is SINGLE-FIELD (the 3.2.4 planner rule)', () => {
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
      expect(fields).not.toContain('UNIQUE');
    }
  });

  it('subject handles are STRINGS, not record links (rows must not dangle)', () => {
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS assetId ON evidence_access TYPE string;');
    expect(sql).toContain(
      'DEFINE FIELD IF NOT EXISTS fragmentId ON evidence_access TYPE option<string>;',
    );
    expect(sql).not.toMatch(/ON evidence_access TYPE record</);
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // The row names a hashed principal + a subject handle; a 30-day feed
    // would keep a GDPR-erased access trail readable after the rows die
    // (0122 reasoning). The header EXPLAINS the absence in prose, so
    // judge only non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('both asset-death sites carry the evidence_access erase leg', () => {
    // The trail dies with its asset in BOTH places assets die: the GDPR
    // user-forget cascade and the retention/quarantine tombstone path
    // (purgeAssetDependents). Both legs must be the two-step
    // SELECT-ids → DELETE-ids idiom over the STRING assetId column.
    const forget = readFileSync(
      join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
      'utf8',
    );
    expect(forget).toContain(
      'LET $accessIds = (SELECT VALUE id FROM evidence_access WHERE assetId INSIDE $strs)',
    );
    expect(forget).toContain('DELETE $accessIds RETURN BEFORE');
    const store = readFileSync(
      join(__dirname, '..', 'src', 'evidence', 'evidence-store.service.ts'),
      'utf8',
    );
    expect(store).toContain('SELECT VALUE id FROM evidence_access WHERE assetId = $assetStr');
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
      expect(text).not.toMatch(/DELETE evidence_grant WHERE/);
      expect(text).not.toMatch(/DELETE evidence_access WHERE/);
    }
  });

  it('user-forget pre-collects the cascade ids (and blob refs) before deleting', () => {
    const src = readFileSync(files[0]!, 'utf8');
    // 0122 grant-aware shape: the user's grant rows and the legacy
    // userId-stamped assets are collected in JS, classified by remaining
    // live grants, and only the SOLE-OWNED ids are bound as $assetIds.
    expect(src).toContain(
      "SELECT id, assetId FROM evidence_grant WHERE ownerKind = 'user' AND ownerId = $u",
    );
    expect(src).toContain('SELECT VALUE id FROM evidence_asset WHERE userId = $u');
    expect(src).toContain(
      'LET $fragIds = (SELECT VALUE id FROM evidence_fragment WHERE assetId INSIDE $assetIds)',
    );
    expect(src).toContain('LET $reprIds = (SELECT VALUE id FROM derived_representation');
    expect(src).toContain(
      'LET $residualGrantIds = (SELECT VALUE id FROM evidence_grant WHERE assetId INSIDE $assetIds)',
    );
    expect(src).toContain('DELETE $reprIds RETURN BEFORE');
    expect(src).toContain('DELETE $fragIds RETURN BEFORE');
    expect(src).toContain('DELETE $residualGrantIds RETURN BEFORE');
    expect(src).toContain('DELETE $assetIds RETURN BEFORE');
    // Blob refs must be collected while the rows still exist.
    expect(src).toContain('SELECT VALUE storageRef FROM evidence_asset');
  });

  it('the retention sweep pre-collects fragment/representation/grant ids per asset', () => {
    const src = readFileSync(files[2]!, 'utf8');
    expect(src).toContain('SELECT VALUE id FROM evidence_fragment WHERE assetId = $asset');
    expect(src).toContain('SELECT VALUE id FROM derived_representation WHERE ${where} LIMIT 5000');
    // 0122: retention death is whole-asset death — grants go too.
    expect(src).toContain('SELECT VALUE id FROM evidence_grant WHERE assetId = $asset');
    expect(src).toContain('await db.query(`DELETE $ids RETURN BEFORE`, { ids });');
    const fragmentReprs = src.indexOf(
      'await this.purgeRepresentationBatches(db, `subjectId INSIDE $subjects`',
    );
    const fragmentDelete = src.indexOf(
      'await db.query(`DELETE $ids RETURN BEFORE`, { ids: fragIds })',
    );
    expect(fragmentReprs).toBeGreaterThan(0);
    expect(fragmentReprs).toBeLessThan(fragmentDelete);
  });
});

describe('0121_evidence_processing_lifecycle', () => {
  const sql = readFileSync(join(MIGRATIONS, '0121_evidence_processing_lifecycle.surql'), 'utf8');

  // Single-field only: processing_run sits on the GDPR delete path, and a
  // compound index would put it under the 3.2.4 compound-planner DELETE
  // no-op class (the 0109 rationale carries over verbatim).
  it.each([
    ['processing_run_asset_idx', 'processing_run', 'assetId'],
    ['processing_run_status_idx', 'processing_run', 'status'],
    ['processing_run_started_idx', 'processing_run', 'startedAt'],
    ['derived_repr_run_idx', 'derived_representation', 'producedByRun'],
    ['derived_repr_superseded_idx', 'derived_representation', 'supersededBy'],
    ['evidence_asset_quarantine_idx', 'evidence_asset', 'quarantineStatus'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('every index is SINGLE-FIELD (no comma after FIELDS)', () => {
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
    }
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // Same GDPR reasoning as 0109: run errors + lineage must not keep
    // erased content discoverable in a feed. The header EXPLAINS the
    // absence in prose, so judge only non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('pins the 0121 enums to the canonical TS taxonomy', () => {
    const capabilityAssert = /capability ON processing_run[^;]*ASSERT[^;]*;/s.exec(sql)?.[0] ?? '';
    const statusAssert = /status ON processing_run[^;]*ASSERT[^;]*;/s.exec(sql)?.[0] ?? '';
    const quarantineAssert =
      /quarantineStatus ON evidence_asset[^;]*ASSERT[^;]*;/s.exec(sql)?.[0] ?? '';
    const values = (statement: string) =>
      [...statement.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(values(capabilityAssert)).toEqual([...DERIVED_REPRESENTATION_KINDS]);
    expect(values(statusAssert)).toEqual([...PROCESSING_RUN_STATUSES]);
    expect(values(quarantineAssert)).toEqual([...QUARANTINE_STATUSES]);
  });

  it('user-forget pre-collects run ids and deletes by ids (LET → DELETE)', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
      'utf8',
    );
    expect(src).toContain('LET $runIds =');
    expect(src).toContain('DELETE $runIds');
  });

  it('no writer uses a one-step DELETE-WHERE on processing_run', () => {
    const writerFiles = [
      join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
      join(__dirname, '..', 'src', 'evidence', 'evidence-store.service.ts'),
      join(__dirname, '..', 'src', 'evidence', 'processor-broker.service.ts'),
      join(__dirname, '..', 'src', 'evidence', 'processing', 'processing-run.service.ts'),
    ];
    for (const file of writerFiles) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/DELETE processing_run WHERE/);
    }
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

describe('0116_memory_support indexes', () => {
  const sql = readFileSync(join(MIGRATIONS, '0116_memory_support.surql'), 'utf8');

  it.each([
    ['support_edge_uq', 'memory_support', 'in, out, kind UNIQUE'],
    ['support_out_idx', 'memory_support', 'out'],
    ['support_kind_idx', 'memory_support', 'kind'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    const re = new RegExp(`DEFINE INDEX IF NOT EXISTS ${name}\\s+ON ${table} FIELDS ${fields};`);
    expect(sql).toMatch(re);
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // The 0053/0107 separation rationale: provenance edges must not
    // feed the audit mirror, and an erased subject's edges must not
    // stay readable in a feed. The header EXPLAINS the absence in
    // prose, so judge only non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });
});

describe('memory_support GDPR cascade + DELETE-shape guards (0116)', () => {
  const SRC = join(__dirname, '..', 'src');

  it('both forget services erase support edges via the two-step SELECT-ids → DELETE idiom', () => {
    // The compound support_edge_uq index covers `in` — a
    // `DELETE memory_support WHERE in INSIDE …` is the REPRODUCED
    // 3.2.4 silent planner no-op (returns OK, deletes zero rows), so
    // the cascade must pre-select ids and delete by them. And it must
    // run UNCONDITIONALLY — rows written while PROVENANCE_SUPPORT_EDGES
    // was on must stay erasable after it is off.
    const userForget = readFileSync(join(SRC, 'entities', 'user-forget.service.ts'), 'utf8');
    expect(userForget).toContain('SELECT VALUE id FROM memory_support');
    expect(userForget).toContain('DELETE $supIds');
    const entityForget = readFileSync(join(SRC, 'entities', 'entity-forget.service.ts'), 'utf8');
    expect(entityForget).toContain('SELECT VALUE id FROM memory_support');
    expect(entityForget).toContain('DELETE $supIds');
    // The entity tx must pre-collect fact ids BEFORE the fact delete
    // erases the rows the subject SELECT enumerates.
    expect(entityForget).toContain(
      'LET $entFactIds = (SELECT VALUE id FROM knowledge_fact WHERE entityId = $ent)',
    );
  });

  it('NO file in src/ uses the 3.2.4-broken DELETE memory_support WHERE shape', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.ts') || p.endsWith('.surql')) out.push(p);
      }
      return out;
    };
    for (const file of walk(SRC)) {
      // Comment lines EXPLAIN the trap (0058-guard idiom) — judge only
      // code lines.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*');
        })
        .join('\n');
      expect(code).not.toMatch(/DELETE memory_support\s+WHERE/);
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

describe('0120_semantic_belief (belief substrate)', () => {
  const sql = readFileSync(join(MIGRATIONS, '0120_semantic_belief.surql'), 'utf8');

  it.each([
    ['belief_user_idx', 'semantic_belief', 'userId'],
    ['belief_subject_idx', 'semantic_belief', 'subject'],
    ['belief_status_idx', 'semantic_belief', 'status'],
  ])('defines %s on %s(%s)', (name, table, fields) => {
    expect(sql).toContain(`DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fields};`);
  });

  it('every index is SINGLE-FIELD (the 3.2.4 planner rule)', () => {
    // A compound index would put its fields into the DELETE-WHERE
    // planner no-op class (reproduced on memory_support during the 0116
    // smoke) — 0120 commits to single-field indexes only;
    // (userId, subject, field, revision) uniqueness is code-enforced via
    // deterministic record ids.
    const defs = sql.match(/DEFINE INDEX[^;]+;/g) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const fields = /FIELDS ([^;]+);/.exec(def)?.[1] ?? '';
      expect(fields).not.toContain(',');
    }
  });

  it('deliberately defines NO changefeed and NO event', () => {
    // The 0053/0107 separation rationale: belief statements
    // quote-derive from scene enrichment, and an erased user's beliefs
    // must not stay readable in a feed. The header EXPLAINS the absence
    // in prose, so judge only non-comment lines.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
  });

  it('widens the 0116 writer enum with belief_promotion via OVERWRITE', () => {
    expect(sql).toContain('DEFINE FIELD OVERWRITE writer ON memory_support');
    expect(sql).toMatch(
      /writer ON memory_support[^;]*'scene_backlink', 'fact_resolver', 'promotion_runner', 'compaction_runner', 'recompose', 'belief_promotion'/s,
    );
  });

  it('widens the never-written consolidatedInto column to generic records', () => {
    expect(sql).toContain(
      'DEFINE FIELD OVERWRITE consolidatedInto ON memory_episode TYPE option<array<record>>;',
    );
  });

  it('stamps the GDPR tombstone counter on forgotten_entity', () => {
    expect(sql).toContain('DEFINE FIELD IF NOT EXISTS beliefsDeleted ON forgotten_entity');
  });

  it('carries the bitemporal vocabulary + explicit revision', () => {
    for (const field of ['validFrom', 'validUntil', 'status', 'supersededBy', 'revision']) {
      expect(sql).toContain(`DEFINE FIELD IF NOT EXISTS ${field} ON semantic_belief`);
    }
  });
});

describe('semantic_belief GDPR cascade + DELETE-shape guards (0120)', () => {
  const SRC = join(__dirname, '..', 'src');

  it('both forget services erase beliefs via the two-step SELECT-ids → DELETE idiom, unconditionally', () => {
    // user-forget: the userId leg is the primary erase (a belief always
    // carries the single-user scope of its scenes — #387 fail-closed
    // promotion), plus the defensive dying-scene leg; belief ids join
    // the memory_support subject list BEFORE the rows die.
    const userForget = readFileSync(join(SRC, 'entities', 'user-forget.service.ts'), 'utf8');
    expect(userForget).toContain('SELECT VALUE id FROM semantic_belief');
    expect(userForget).toContain('sourceSceneIds CONTAINSANY $scenes');
    // entity-forget: scene-mediated — beliefs grounded in dying scenes
    // go with them, pre-collected inside the atomic transaction.
    const entityForget = readFileSync(join(SRC, 'entities', 'entity-forget.service.ts'), 'utf8');
    expect(entityForget).toContain('LET $beliefIds = (SELECT VALUE id FROM semantic_belief');
    expect(entityForget).toContain('sourceSceneIds CONTAINSANY $sceneIds');
    expect(entityForget).toContain('LET $beliefsDel = (DELETE $beliefIds RETURN BEFORE)');
    // The belief endpoints must join the support-edge subject SELECT.
    expect(entityForget).toContain('OR in INSIDE $beliefIds OR out INSIDE $beliefIds');
  });

  it('NO file in src/ uses the 3.2.4-broken DELETE semantic_belief WHERE shape', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.ts') || p.endsWith('.surql')) out.push(p);
      }
      return out;
    };
    for (const file of walk(SRC)) {
      // Comment lines EXPLAIN the trap (0058-guard idiom) — judge only
      // code lines.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*');
        })
        .join('\n');
      expect(code).not.toMatch(/DELETE semantic_belief\s+WHERE/);
    }
  });
});

describe('0117_window_user_scope (mixed-user privacy fence substrate)', () => {
  const sql = readFileSync(join(MIGRATIONS, '0117_window_user_scope.surql'), 'utf8');

  it('defines the userIds member set on both window tables', () => {
    expect(sql).toContain(
      'DEFINE FIELD IF NOT EXISTS userIds ON episode_segment TYPE option<array<string>>;',
    );
    expect(sql).toContain(
      'DEFINE FIELD IF NOT EXISTS userIds ON memory_episode TYPE option<array<string>>;',
    );
  });

  it('deliberately defines NO index (3.2.4 compound-index planner risk)', () => {
    expect(sql).not.toContain('DEFINE INDEX');
  });
});

describe('0124_fragment_content_search (fragment lane BM25 leg)', () => {
  const sql = readFileSync(join(MIGRATIONS, '0124_fragment_content_search.surql'), 'utf8');

  it('defines the BM25 content index with the lowercase-only analyzer', () => {
    // The 0073/0075/0106 analyzer contract: lowercase only — snowball
    // stemming would mangle non-Latin scripts, and caption/OCR/ASR text
    // is multilingual by nature.
    expect(sql).toContain(
      'DEFINE ANALYZER IF NOT EXISTS fragment_content TOKENIZERS class FILTERS lowercase;',
    );
    expect(sql).toMatch(
      /DEFINE INDEX IF NOT EXISTS derived_repr_content_search ON derived_representation\s+FIELDS content FULLTEXT ANALYZER fragment_content BM25;/,
    );
  });

  it.each([['derived_repr_content_search', 'derived_representation', 'content']])(
    'defines %s on %s(%s) single-field (3.2.4 compound-planner DELETE risk)',
    (name, table) => {
      const indexLines = sql
        .split('\n')
        .filter((l) => l.trimStart().startsWith('DEFINE INDEX'))
        .filter((l) => l.includes(name) && l.includes(table));
      expect(indexLines.length).toBeGreaterThan(0);
      for (const line of indexLines) {
        expect(line).not.toMatch(/FIELDS [A-Za-z]+,/);
      }
    },
  );

  it('deliberately defines NO changefeed, NO event, NO new field', () => {
    // Index-only migration: the 0109 GDPR reasoning stands (derived
    // caption/OCR/ASR text must not stay readable in a feed after an
    // erasure), and the storage shape is untouched.
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/CHANGEFEED/);
    expect(code).not.toMatch(/DEFINE EVENT/);
    expect(code).not.toMatch(/DEFINE FIELD/);
  });
});
