import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RecordId, StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import { packMemoryProjectionsEnabled } from '../common/pack-projection-flags';
import { idTailOf } from '../ingest/ingest-utils';
import { CandidateStoreService, type CandidateRow } from './candidate-store.service';
import type { StoredDocument } from './document-store.service';

/** Builder stamp (registry + source.recorder) for pack scene projections. */
export const PACK_SCENE_PROJECTOR = 'pack-scene-projector-v1';

/**
 * Effective segmenterVersion for one pack's scene world:
 * `pack:<packId>+<8-hex fp>` — the effectiveSegmenterVersion mold with a
 * `pack:` namespace, so it can NEVER collide with the composer's
 * `scene-segmenter-v1*` id-spaces. The fingerprint hashes the projector
 * impl + pack identity + pack version (canonical `|`-joined string, the
 * sceneConfigFingerprint idiom): a pack UPGRADE forks a fresh coexisting
 * world instead of overwriting the old one in place, and abandoned worlds
 * are purged through the existing
 * DELETE /v1/admin/maintenance/scenes/versions/:segmenterVersion verb —
 * `:` and `+` are literal characters in a URL path segment.
 */
export function packSceneVersion(packId: string, packVersion: string): string {
  const fp = createHash('sha256')
    .update(`impl=${PACK_SCENE_PROJECTOR}|pack=${packId}|packVersion=${packVersion}`)
    .digest('hex')
    .slice(0, 8);
  return `pack:${packId}+${fp}`;
}

/** One run's projection outcome (observability + tests). */
export interface SceneProjectionOutcome {
  packId: string;
  version: string;
  scenes: number;
  stateDeltas: number;
  rejected: number;
}

interface SceneGroup {
  packId: string;
  packVersion: string;
  scenes: CandidateRow[];
  deltas: CandidateRow[];
}

type StatusUpdate = {
  id: string;
  status: string;
  statusReason?: string | undefined;
  commitRef?: string | undefined;
};

/**
 * Projects ACCEPTED (staged-pending) 'scene' / 'state_delta' candidates
 * (migration 0110) into shadow memory_episode rows — the episodic-plane
 * sibling of what CommitWriterService does for the semantic trio.
 *
 * Invoked by CandidateCommitService at the end of the per-document commit
 * (inside the same per-(company, doc) lock) ONLY when
 * PACK_MEMORY_PROJECTIONS_ENABLED is on; rechecked here defensively.
 *
 * SHADOW (0106 contract): nothing on the serving path reads
 * memory_episode, so projection is behavior-invisible even when on.
 * Rows are stamped segmenterVersion = `pack:<packId>+<fp>` and register
 * in the projection ledger as (name `scenes:<packId>`, version) with one
 * ISO-timestamp generation per run (0081 idiom), live: false — exactly
 * the composer's registration shape, one ledger for both writers.
 *
 * Idempotency: episode ids are deterministic
 * (sha256(docId|version|sceneIndex), the composer's sceneIdTail mold) and
 * each run atomically swaps THIS (document × version) slice — LET-select-
 * ids → DELETE, then INSERT — so a drop-and-restage resubmission
 * converges instead of duplicating. Other packs' worlds and the
 * composer's conversation scenes are untouched by construction.
 *
 * Document scenes quote no L0 episode turn, so NO memory_episode_member
 * rows are written; erasure is keyed by source.docId — the entity-forget
 * document cascade owns it (unconditionally — see 0110's header).
 *
 * Failure posture: a projection error must not fail the semantic commit
 * that already happened — the group's ledger row goes 'failed', its
 * candidates stay 'pending' (the sweeper's TTL is the backstop), and the
 * error is logged. Registry writes themselves never throw (its `safely`
 * contract).
 */
@Injectable()
export class SceneCandidateWriterService {
  private readonly logger = new Logger(SceneCandidateWriterService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly candidates: CandidateStoreService,
    private readonly registry: ProjectionRegistryService,
  ) {}

  /** rows = the commit's pending candidates of kind scene/state_delta. */
  async projectDocument(
    companyId: string,
    doc: StoredDocument,
    rows: CandidateRow[],
  ): Promise<SceneProjectionOutcome[]> {
    if (!packMemoryProjectionsEnabled() || rows.length === 0) return [];
    const outcomes: SceneProjectionOutcome[] = [];
    for (const group of groupByRun(rows).values()) {
      const version = packSceneVersion(group.packId, group.packVersion);
      const name = `scenes:${group.packId}`;
      await this.registry.begin({ companyId, name, version, builder: PACK_SCENE_PROJECTOR });
      try {
        const outcome = await this.projectGroup({ companyId, doc, group, version });
        await this.registry.complete({
          companyId,
          name,
          version,
          live: false,
          stats: { docId: doc.id, scenes: outcome.scenes, stateDeltas: outcome.stateDeltas },
        });
        outcomes.push(outcome);
      } catch (e) {
        await this.registry.fail({ companyId, name, version });
        this.logger.warn(
          `scene projection failed for pack ${group.packId} on doc ${doc.id}: ${(e as Error).message}`,
        );
      }
    }
    return outcomes;
  }

  private async projectGroup(p: {
    companyId: string;
    doc: StoredDocument;
    group: SceneGroup;
    version: string;
  }): Promise<SceneProjectionOutcome> {
    const { doc, group, version } = p;
    const generation = new Date().toISOString();
    const updates: StatusUpdate[] = [];
    const episodeRows: Record<string, unknown>[] = [];
    /** payload.sceneIndex → projected episode id (for delta commitRefs). */
    const idBySceneIndex = new Map<number, string>();

    for (const row of group.scenes) {
      const sceneIndex = Number(row.payload.sceneIndex);
      const label = row.payload.label;
      const gist = row.payload.gist;
      if (!Number.isInteger(sceneIndex) || typeof label !== 'string' || typeof gist !== 'string') {
        updates.push({ id: row.id, status: 'rejected', statusReason: 'malformed_scene' });
        continue;
      }
      const idTail = sceneRowIdTail(doc.id, version, sceneIndex);
      const episodeId = `memory_episode:${idTail}`;
      idBySceneIndex.set(sceneIndex, episodeId);
      episodeRows.push({
        id: new RecordId('memory_episode', idTail),
        // No userId key: documents are tenant-scoped (StoredDocument
        // carries none), so the projected scene stays tenant-global —
        // the 0055 fold with an empty member set.
        scope: [],
        sceneLabel: label,
        // No conversation backs a document scene; erasure and rebuild are
        // keyed by source.docId instead.
        conversationIds: [],
        occurredFrom: toDate(row.payload.occurredFrom) ?? doc.occurredAt,
        occurredTo: toDate(row.payload.occurredTo) ?? doc.occurredAt,
        gist,
        confidence: clamp01(row.confidence),
        segmenterVersion: version,
        generation,
        source: {
          recorder: PACK_SCENE_PROJECTOR,
          docId: new StringRecordId(`source_document:${idTailOf(doc.id)}`),
          packId: group.packId,
          packVersion: group.packVersion,
          schemaId: row.payload.schemaId,
          candidateId: row.id,
        },
        stateDeltas: deltasForScene(group.deltas, sceneIndex),
      });
      updates.push({ id: row.id, status: 'committed', commitRef: episodeId });
    }

    for (const row of group.deltas) {
      const episodeId = idBySceneIndex.get(Number(row.payload.sceneIndex));
      updates.push(
        episodeId
          ? { id: row.id, status: 'committed', commitRef: episodeId }
          : { id: row.id, status: 'rejected', statusReason: 'orphan_scene_reference' },
      );
    }

    await this.swapDocumentScenes({ companyId: p.companyId, docId: doc.id, version, episodeRows });
    await this.candidates.markStatuses(p.companyId, updates);
    return {
      packId: group.packId,
      version,
      scenes: episodeRows.length,
      stateDeltas: updates.filter((u) => u.status === 'committed').length - episodeRows.length,
      rejected: updates.filter((u) => u.status === 'rejected').length,
    };
  }

  /**
   * Atomic swap of THIS (document × version) slice — the composer's
   * conversation-swap mold keyed by source.docId. Member delete is
   * LET-select-ids → DELETE DELIBERATELY (defensive: this writer creates
   * no member rows, but a DELETE whose WHERE filters on `in` — covered
   * only by the COMPOUND scene_member_uq index — is the SurrealDB 3.2.4
   * silent-no-op planner shape); the scene delete filters on plain
   * pre-collected ids for the same reason.
   */
  private async swapDocumentScenes(p: {
    companyId: string;
    docId: string;
    version: string;
    episodeRows: Record<string, unknown>[];
  }): Promise<void> {
    const { docId, version, episodeRows } = p;
    await this.surreal.withCompany(p.companyId, (db) =>
      runTransaction(db as unknown as Surreal, (tx) => {
        tx.add(
          `LET $oldIds = (SELECT VALUE id FROM memory_episode
             WHERE segmenterVersion = $v AND source.docId = $doc)`,
        )
          .add(
            `LET $oldMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $oldIds)`,
          )
          .add(`DELETE $oldMemberIds`)
          .add(`DELETE memory_episode WHERE id INSIDE $oldIds`)
          .bind('v', version)
          .bind('doc', new StringRecordId(`source_document:${idTailOf(docId)}`));
        if (episodeRows.length > 0) {
          tx.add(`INSERT INTO memory_episode $rows`).bind('rows', episodeRows);
        }
        tx.add(`RETURN { swapped: array::len($oldIds) }`);
      }),
    );
  }
}

function groupByRun(rows: CandidateRow[]): Map<string, SceneGroup> {
  const groups = new Map<string, SceneGroup>();
  for (const row of rows) {
    let group = groups.get(row.runId);
    if (!group) {
      group = {
        packId: String(row.payload.indexerId ?? ''),
        packVersion: String(row.payload.packVersion ?? '0'),
        scenes: [],
        deltas: [],
      };
      groups.set(row.runId, group);
    }
    (row.kind === 'scene' ? group.scenes : group.deltas).push(row);
  }
  return groups;
}

function deltasForScene(deltas: CandidateRow[], sceneIndex: number): Record<string, unknown>[] {
  return deltas
    .filter((d) => Number(d.payload.sceneIndex) === sceneIndex)
    .map((d) => ({
      stateModelId: d.payload.stateModelId,
      subject: d.payload.subject,
      from: d.payload.from,
      to: d.payload.to,
      confidence: clamp01(d.confidence),
      candidateId: d.id,
    }));
}

/** sceneIdTail mold: deterministic per (document × version × index). */
function sceneRowIdTail(docId: string, version: string, sceneIndex: number): string {
  return createHash('sha256')
    .update(`${docId}|${version}|${sceneIndex}`)
    .digest('hex')
    .slice(0, 24);
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0, n));
}
