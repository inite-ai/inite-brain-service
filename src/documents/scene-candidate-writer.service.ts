import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { ProjectionRegistryService } from '../episodes/projection-registry.service';
import {
  PACK_SCENE_PROJECTOR,
  buildPackSceneRow,
  packDeltaField,
  packSceneIdTail,
  packSceneProjectionName,
  packSceneScopeStamp,
  packSceneVersion,
  packStateDeltaEntry,
  packStateModelIndex,
  swapPackSceneSlice,
  type PackStateModelIndex,
} from '../episodes/pack-scene-projection';
import { packMemoryProjectionsEnabled } from '../common/pack-projection-flags';
import { idTailOf } from '../ingest/ingest-utils';
import { MemoryModelReaderService } from '../ai/memory-model-reader.service';
import { CandidateStoreService, type CandidateRow } from './candidate-store.service';
import type { StoredDocument } from './document-store.service';

// The projector stamp, its version mold, the row builder and the
// stateModelId -> belief-field mapping are SHARED with the capture-path
// producer (MentionProjectionService) — one shape, two origins.
// Re-exported here for API continuity (the 0110 specs and the e2e import
// them from this module).
export { PACK_SCENE_PROJECTOR, packDeltaField, packSceneVersion };

/**
 * Per-user scope stamp for a projected scene row (0128): a user-scoped
 * document's scenes carry the document's user — the shared
 * packSceneScopeStamp fold (userId + the 0093 scope tag + the 0117
 * userIds membership set). Exported pure for unit tests.
 */
export function sceneScopeStamp(doc: Pick<StoredDocument, 'userId'>): Record<string, unknown> {
  return packSceneScopeStamp(doc.userId);
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
 * STATE DELTAS carry BOTH `stateModelId` (the pack provenance) and
 * `field` = `<packId>__<stateModel.field ?? stateModelId>`
 * (packDeltaField) — the belief plane keys on (userId, subject, field)
 * and drops fieldless deltas, so without the mapping these projections
 * were a write with no reader. The pack-namespaced field is also the
 * cross-pack collision rule: two packs whose lifecycles share a local
 * attribute name stay in separate belief groups by construction.
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

  // The four collaborators are the four planes this one projection
  // touches — episode rows (surreal), candidate statuses (candidates),
  // the projection ledger (registry) and the pack's own declarations
  // (memoryModels, the stateModelId -> field mapping input). Splitting
  // would only add a pass-through class (the CandidateCommitService
  // precedent one file over).
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly candidates: CandidateStoreService,
    private readonly registry: ProjectionRegistryService,
    private readonly memoryModels: MemoryModelReaderService,
  ) {}

  /** rows = the commit's pending candidates of kind scene/state_delta. */
  async projectDocument(
    companyId: string,
    doc: StoredDocument,
    rows: CandidateRow[],
  ): Promise<SceneProjectionOutcome[]> {
    if (!packMemoryProjectionsEnabled() || rows.length === 0) return [];
    // stateModelId -> field mapping input, resolved ONCE per commit (the
    // reader is LRU+TTL cached and fail-open, so this is at most one
    // domain_pack read per tenant per 30s).
    const stateModels = await this.stateModelsByPack(companyId);
    const outcomes: SceneProjectionOutcome[] = [];
    for (const group of groupByRun(rows).values()) {
      const version = packSceneVersion(group.packId, group.packVersion);
      const name = packSceneProjectionName(group.packId);
      await this.registry.begin({ companyId, name, version, builder: PACK_SCENE_PROJECTOR });
      try {
        const outcome = await this.projectGroup({
          companyId,
          doc,
          group,
          version,
          models: stateModels.get(group.packId),
        });
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

  /**
   * packId -> (stateModelId -> declaration) for the tenant's installed
   * packs. Fail-open by contract (MemoryModelReaderService degrades to
   * builtins-only on a read error): an unresolvable pack falls back to the
   * stateModelId as the local field name — the projection never fails for
   * a manifest hiccup.
   */
  private async stateModelsByPack(companyId: string): Promise<Map<string, PackStateModelIndex>> {
    const byPack = new Map<string, PackStateModelIndex>();
    for (const binding of await this.memoryModels.installedMemoryModels(companyId)) {
      byPack.set(binding.packId, packStateModelIndex(binding.memoryModel.stateModels));
    }
    return byPack;
  }

  private async projectGroup(p: {
    companyId: string;
    doc: StoredDocument;
    group: SceneGroup;
    version: string;
    models: PackStateModelIndex | undefined;
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
      const idTail = packSceneIdTail(doc.id, version, sceneIndex);
      const episodeId = `memory_episode:${idTail}`;
      idBySceneIndex.set(sceneIndex, episodeId);
      episodeRows.push(
        // The SHARED row shape (buildPackSceneRow) — identical to what the
        // capture-path producer writes, modulo the origin provenance.
        buildPackSceneRow({
          idTail,
          // Per-user scope (0128) — see sceneScopeStamp.
          userId: doc.userId,
          sceneLabel: label,
          // No conversation backs a document scene; erasure and rebuild are
          // keyed by source.docId instead.
          conversationIds: [],
          occurredFrom: toDate(row.payload.occurredFrom) ?? doc.occurredAt,
          occurredTo: toDate(row.payload.occurredTo) ?? doc.occurredAt,
          gist,
          confidence: row.confidence,
          version,
          generation,
          origin: {
            docId: new StringRecordId(`source_document:${idTailOf(doc.id)}`),
            packId: group.packId,
            packVersion: group.packVersion,
            schemaId: row.payload.schemaId,
            candidateId: row.id,
          },
          stateDeltas: projectSceneDeltas({
            deltas: group.deltas,
            sceneIndex,
            packId: group.packId,
            models: p.models,
          }),
        }),
      );
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
   * Atomic swap of THIS (document × version) slice — the SHARED
   * swapPackSceneSlice keyed by source.docId (the slice's size is the
   * last submission's, so the ids are SELECT-collected, not derived).
   */
  private async swapDocumentScenes(p: {
    companyId: string;
    docId: string;
    version: string;
    episodeRows: Record<string, unknown>[];
  }): Promise<void> {
    const { docId, version, episodeRows } = p;
    await this.surreal.withCompany(p.companyId, (db) =>
      swapPackSceneSlice(db as unknown as Surreal, {
        version,
        key: {
          by: 'source',
          field: 'docId',
          value: new StringRecordId(`source_document:${idTailOf(docId)}`),
        },
        sceneRows: episodeRows,
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

/**
 * One scene's projected stateDeltas — the SHARED packStateDeltaEntry
 * shape (the capture path writes the identical entry, modulo the
 * document-only `candidateId`), narrowed to this scene index.
 *
 * `field` (packDeltaField) rides ALONGSIDE `stateModelId`, never instead
 * of it: `stateModelId` stays the pack provenance (which lifecycle
 * declaration produced the claim), `field` is the belief plane's key.
 * Both are additive on a FLEXIBLE column (0106) — existing rows without
 * `field` stay valid and simply keep being invisible to the promoter.
 *
 * Exported pure for the round-trip unit test (projected shape → the
 * belief fold's collectSceneDeltas).
 */
export function projectSceneDeltas(p: {
  deltas: CandidateRow[];
  sceneIndex: number;
  packId: string;
  models: PackStateModelIndex | undefined;
}): Record<string, unknown>[] {
  return p.deltas
    .filter((d) => Number(d.payload.sceneIndex) === p.sceneIndex)
    .map((d) =>
      packStateDeltaEntry({
        packId: p.packId,
        stateModelId: d.payload.stateModelId,
        models: p.models,
        subject: d.payload.subject,
        from: d.payload.from,
        to: d.payload.to,
        confidence: d.confidence,
        candidateId: d.id,
      }),
    );
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}
