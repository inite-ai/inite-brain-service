import { createHash } from 'node:crypto';
import { RecordId, type Surreal } from 'surrealdb';
import { runTransaction } from '../db/surreal.service';
import { scopeForUser } from '../auth/scope-tags';

/**
 * Pack scene projections — the SHARED write shape (migration 0110,
 * PACK_MEMORY_PROJECTIONS_ENABLED).
 *
 * A pack declares HOW its domain episodizes memory (manifest
 * `memoryModel.sceneSchemas` / `stateModels`); two producers turn that
 * declaration into shadow `memory_episode` rows:
 *
 *   * the DOCUMENT path — SceneCandidateWriterService, projecting
 *     staged `scene`/`state_delta` candidates at commit time;
 *   * the CAPTURE path — MentionProjectionService, projecting one
 *     dialogue turn at ingest time (cue-literal derivation, model-free).
 *
 * Both MUST write the same row: same table, same id mold, same
 * scope/PII/userId stamping (the 0055 per-user fence, the 0093 scope tag,
 * the 0117 userIds membership fold), the same `pack:<packId>+<fp>`
 * segmenterVersion id-space, and the same slice-swap semantics. That is
 * what lives here — one shape, two origins, no drift.
 *
 * Pure module by design (engine-gates S5.2): no env reads, no Nest
 * injection. The flag fence stays with each producer.
 */

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
 *
 * BOTH origins share the world: a tenant that receives the same domain
 * through documents AND through conversation gets one pack world, not two.
 */
export function packSceneVersion(packId: string, packVersion: string): string {
  const fp = createHash('sha256')
    .update(`impl=${PACK_SCENE_PROJECTOR}|pack=${packId}|packVersion=${packVersion}`)
    .digest('hex')
    .slice(0, 8);
  return `pack:${packId}+${fp}`;
}

/** Projection-ledger name for one pack's scene world (both origins). */
export function packSceneProjectionName(packId: string): string {
  return `scenes:${packId}`;
}

/**
 * Per-user scope stamp for a projected scene row (0128 for documents,
 * the capture path's turn userId for mentions): a user-scoped origin's
 * scenes carry that user — userId + the 0093 scope tag + the 0117
 * userIds membership fold (single-user by construction), the composer's
 * exact stamp shape, so the PRIVACY_SEGMENT_USER_FENCE read contract
 * fences them without backfill. A tenant-global origin keeps the
 * pre-0128 row byte-identical — the 0055 fold with an empty member set.
 */
export function packSceneScopeStamp(userId: string | undefined): Record<string, unknown> {
  return userId ? { userId, scope: scopeForUser(userId), userIds: [userId] } : { scope: [] };
}

/**
 * Deterministic scene id tail — the composer's sceneIdTail mold with the
 * origin's own owner key: `<owner>|<version>|<discriminator>`.
 *
 *   * documents  — owner = docId,     discriminator = submission sceneIndex;
 *   * capture    — owner = episodeId, discriminator = the pack's schemaId
 *     (one scene per (turn, pack, schema): the capture path's idempotency
 *     key, so a replayed turn converges on the same row instead of
 *     appending a second copy).
 */
export function packSceneIdTail(
  owner: string,
  version: string,
  discriminator: string | number,
): string {
  return createHash('sha256')
    .update(`${owner}|${version}|${discriminator}`)
    .digest('hex')
    .slice(0, 24);
}

/** One projected scene's inputs — origin-agnostic. */
export interface PackSceneRowInput {
  /** Deterministic tail from packSceneIdTail. */
  idTail: string;
  /** Owning user, when the origin is single-user (0055/0093/0117 fold). */
  userId?: string | undefined;
  /** PII classes of the projected text (0106); omitted when none. */
  piiClass?: readonly string[] | undefined;
  sceneLabel: string;
  conversationIds: string[];
  occurredFrom: Date;
  occurredTo: Date;
  gist: string;
  confidence: number;
  /** packSceneVersion(packId, packVersion). */
  version: string;
  /** One ISO stamp per producer run (0081 idiom). */
  generation: string;
  /** Origin-specific provenance, merged under the shared recorder stamp. */
  origin: Record<string, unknown>;
  stateDeltas: Record<string, unknown>[];
}

/**
 * The ONE memory_episode row shape both origins write. Optional keys are
 * spread-omitted rather than written as undefined, so a document-origin
 * row stays byte-identical to the pre-capture-path row set.
 */
export function buildPackSceneRow(p: PackSceneRowInput): Record<string, unknown> {
  return {
    id: new RecordId('memory_episode', p.idTail),
    ...packSceneScopeStamp(p.userId),
    ...(p.piiClass && p.piiClass.length > 0 ? { piiClass: [...p.piiClass] } : {}),
    sceneLabel: p.sceneLabel,
    conversationIds: p.conversationIds,
    occurredFrom: p.occurredFrom,
    occurredTo: p.occurredTo,
    gist: p.gist,
    confidence: clampConfidence(p.confidence),
    segmenterVersion: p.version,
    generation: p.generation,
    source: { recorder: PACK_SCENE_PROJECTOR, ...p.origin },
    stateDeltas: p.stateDeltas,
  };
}

/** One entry of the scene row's `stateDeltas` array (0106 FLEXIBLE). */
export interface PackStateDeltaInput {
  stateModelId: unknown;
  subject: unknown;
  from?: unknown;
  to: unknown;
  confidence: number;
  /** Document origin only — the staged candidate this delta came from. */
  candidateId?: string | undefined;
}

export function packStateDeltaEntry(p: PackStateDeltaInput): Record<string, unknown> {
  return {
    stateModelId: p.stateModelId,
    subject: p.subject,
    from: p.from,
    to: p.to,
    confidence: clampConfidence(p.confidence),
    ...(p.candidateId === undefined ? {} : { candidateId: p.candidateId }),
  };
}

/**
 * How the slice being replaced is addressed:
 *
 *   * `source` — collect the ids with a SELECT on the origin's ownership
 *     field (the document path: every scene of THIS document × version,
 *     however many the last submission staged);
 *   * `ids` — the ids are already known (the capture path: one row per
 *     declared schema of the pack, derived from the turn's episode id),
 *     so the swap is primary-key addressed and costs no extra read on a
 *     per-turn hot path.
 */
export type PackSceneSliceKey =
  { by: 'source'; field: 'docId' | 'episodeId'; value: unknown } | { by: 'ids'; ids: RecordId[] };

/**
 * Atomic swap of ONE (origin × version) scene slice: old rows out, new
 * rows in, one transaction — readers see the previous set or the new one,
 * never neither, and no other pack world (or the composer's conversation
 * scenes) is touched.
 *
 * Member delete is LET-select-ids → DELETE DELIBERATELY: a DELETE whose
 * WHERE filters on `in` — covered only by the COMPOUND scene_member_uq
 * index — is the SurrealDB 3.2.4 silent-no-op planner shape. The scene
 * delete filters on plain pre-collected ids for the same reason.
 */
export async function swapPackSceneSlice(
  db: Surreal,
  p: {
    version: string;
    key: PackSceneSliceKey;
    sceneRows: Record<string, unknown>[];
    /** memory_episode_member rows (capture origin); documents write none. */
    memberRows?: Record<string, unknown>[];
  },
): Promise<void> {
  const memberRows = p.memberRows ?? [];
  await runTransaction(db, (tx) => {
    if (p.key.by === 'ids') {
      tx.add(`LET $oldIds = $sliceIds`).bind('sliceIds', p.key.ids);
    } else {
      // `field` is a closed union of literals, never caller input.
      tx.add(
        `LET $oldIds = (SELECT VALUE id FROM memory_episode
           WHERE segmenterVersion = $v AND source.${p.key.field} = $owner)`,
      )
        .bind('v', p.version)
        .bind('owner', p.key.value);
    }
    tx.add(
      `LET $oldMemberIds = (SELECT VALUE id FROM memory_episode_member WHERE in INSIDE $oldIds)`,
    )
      .add(`DELETE $oldMemberIds`)
      .add(`DELETE memory_episode WHERE id INSIDE $oldIds`);
    if (p.sceneRows.length > 0) {
      tx.add(`INSERT INTO memory_episode $rows`).bind('rows', p.sceneRows);
    }
    if (memberRows.length > 0) {
      tx.add(`INSERT RELATION INTO memory_episode_member $memberRows`).bind(
        'memberRows',
        memberRows,
      );
    }
    tx.add(`RETURN { swapped: array::len($oldIds) }`);
  });
}

/** 0106 asserts confidence ∈ [0,1]; a non-finite input takes the 0.7 default. */
export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0, n));
}
