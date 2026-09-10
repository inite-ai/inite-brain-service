import { createHash } from 'node:crypto';
import { mediaPiiAllowed } from '../common/media-pii';
import { sceneVisibleToUser } from '../auth/segment-scope';

/**
 * ONE per-evidence visibility fence and ONE lifecycle stamp per evidence
 * kind, shared by the serving lanes and by the answer cache's
 * check-on-read (round-2 audit F1).
 *
 * The contract: a cached answer may only be served to a caller who would
 * pass the SAME fence the serving lane applied when the evidence entered
 * the prompt. The lane's fence is scope-dependent (media PII against
 * `brain:read_media`, text PII against `brain:read_pii`, asset/scene
 * ownership, tenant modality consent, the live scene world) and none of
 * that is visible in a lifecycle stamp, so re-checking the stamp alone
 * let a `brain:read` key read closed media text out of an entry admitted
 * by a `brain:read_media` key. The scoped DB connection cannot help: its
 * system user bypasses table and field PERMISSIONS, so the fence has to
 * live in the application.
 *
 * Pure module: no DI, no IO, no env. The caller supplies the row, its own
 * scope set, and the tenant-level state (consent, live scene world) it
 * read for this request.
 */

/** Who is asking — the two caller-side inputs every fence reads. */
export interface EvidenceCaller {
  /** Effective scope set of the request. */
  callerScopes: readonly string[];
  /** Pinned end-user scope; undefined = tenant-global (M2M). */
  userId: string | undefined;
}

/** Tenant-level state the fences need, read once per request. */
export interface EvidenceWorldState {
  /** Live `scenes` projection version; null = no queryable scene world. */
  sceneWorld: string | null;
  /** Tenant holds CURRENT non-text modality consent (migration 0112). */
  mediaConsent: boolean;
}

/**
 * The whole fence context of one read, bundled so a caller threads ONE
 * argument through the per-kind dispatch instead of two.
 */
export interface EvidenceFences {
  caller: EvidenceCaller;
  world: EvidenceWorldState;
}

/**
 * JS mirror of the `userId IS NONE [OR userId = $u]` row fence (migration
 * 0055): an unstamped row is tenant-global and visible to everyone in the
 * tenant; a stamped row needs a scoped caller who IS that user. An
 * unscoped (M2M) caller sees tenant-global rows ONLY — the same
 * fail-closed shape the SQL legs compose.
 */
function ownerVisible(owner: unknown, userId: string | undefined): boolean {
  const stamped = typeof owner === 'string' && owner.length > 0 ? owner : null;
  if (stamped === null) return true;
  return userId !== undefined && stamped === userId;
}

/**
 * JS mirror of the text-PII fence `piiClass IS NONE` (episode / scene
 * lanes). Absence is open, ANY stored value — including the empty array —
 * is closed without `brain:read_pii`, exactly as the SQL comparison
 * behaves. Note the deliberate polarity difference from media PII, where
 * absence is closed; see src/common/media-pii.ts.
 */
function textPiiVisible(piiClass: unknown, callerScopes: readonly string[]): boolean {
  if (callerScopes.includes('brain:read_pii')) return true;
  return piiClass === undefined || piiClass === null;
}

/** A `derived_representation`/`evidence_fragment` row as the fence reads it. */
export interface FragmentVisibilityRow {
  /** The FRAGMENT's own media classification (0109 `piiClasses`). */
  piiClasses?: unknown;
  /** Parent asset's single owner (0109 `evidence_asset.userId`). */
  assetUserId?: unknown;
  /** Parent asset's availability — a 'gone' tombstone never serves. */
  assetAvailability?: unknown;
}

/**
 * Fragment-lane fence stack (FragmentLaneService fences 2/3/4/5): tenant
 * modality consent, media PII on the fragment's own classification, the
 * asset-join owner fence, and the availability tombstone. Fail-closed on
 * every axis — an unclassified fragment is closed, a missing consent row
 * empties the lane.
 */
export function fragmentVisible(
  row: FragmentVisibilityRow,
  caller: EvidenceCaller,
  world: Pick<EvidenceWorldState, 'mediaConsent'>,
): boolean {
  if (!world.mediaConsent) return false;
  if (!mediaPiiAllowed(stringArray(row.piiClasses), caller.callerScopes)) return false;
  if (!ownerVisible(row.assetUserId, caller.userId)) return false;
  return String(row.assetAvailability ?? '') !== 'gone';
}

/** A `memory_episode` row as the fence reads it. */
export interface SceneVisibilityRow {
  userId?: unknown;
  userIds?: unknown;
  piiClass?: unknown;
  segmenterVersion?: unknown;
}

/**
 * Scene-lane fence stack (SceneLaneService fences 2/3/5): scoped-user-only
 * (an unscoped request serves NO scene), the 0117 per-member gate, the
 * text-PII gate, and membership of the world the projection registry
 * marks LIVE. The world clause is what makes a version promotion close a
 * cached answer: promotion demotes the previous version to 'residual'
 * without deleting its rows, so a lifecycle stamp alone never moves.
 */
export function sceneVisible(
  row: SceneVisibilityRow,
  caller: EvidenceCaller,
  world: Pick<EvidenceWorldState, 'sceneWorld'>,
): boolean {
  if (caller.userId === undefined) return false;
  if (!sceneVisibleToUser(row, caller.userId)) return false;
  if (!textPiiVisible(row.piiClass, caller.callerScopes)) return false;
  const live = world.sceneWorld;
  if (typeof live !== 'string' || live === '') return false;
  return String(row.segmenterVersion ?? '') === live;
}

/** An `episode` row as the fence reads it. */
export interface EpisodeVisibilityRow {
  userId?: unknown;
  piiClass?: unknown;
}

/** Episode-lane fence stack (EpisodeReadStoreService piiGate + userGate). */
export function episodeVisible(row: EpisodeVisibilityRow, caller: EvidenceCaller): boolean {
  return (
    textPiiVisible(row.piiClass, caller.callerScopes) && ownerVisible(row.userId, caller.userId)
  );
}

/** A `semantic_belief` row as the fence reads it. */
export interface BeliefVisibilityRow {
  userId?: unknown;
}

/**
 * Belief-lane fence (BeliefLaneService fence 2). Migration 0120 stamps
 * every belief with a single owner (`userId TYPE string`), so the owner
 * fence alone reproduces the lane's scoped-user-only rule: an unscoped
 * caller sees no stamped row. The belief lane carries NO scope-dependent
 * fence beyond it — no PII column, no consent, no versioned world — which
 * is why a cached belief arm needs no more re-checking than this.
 */
export function beliefLaneVisible(row: BeliefVisibilityRow, caller: EvidenceCaller): boolean {
  return ownerVisible(row.userId, caller.userId);
}

/**
 * The lifecycle stamp of each kind — the value that must not move for a
 * cached answer to stay valid. Computed by the LANE at retrieval time
 * (carried into admission as the snapshot) and by the answer cache at
 * admission and on every read, so all three read the same function.
 */
export function beliefStamp(row: { revision?: unknown }): string {
  return String(row.revision ?? '');
}

/** An episode's text is immutable — existence IS its lifecycle. */
export function episodeStamp(): string {
  return '';
}

/** A fragment row is immutable; its parent asset's quarantine state moves. */
export function fragmentStamp(row: { quarantineStatus?: unknown }): string {
  return String(row.quarantineStatus ?? '');
}

/**
 * A scene's stamp covers EVERY field the scene lane renders into the
 * prompt: the gist, the LLM-refined gist, and the notable-details payload.
 * `unexpectedDetails` was missing from it while the enricher rewrites
 * exactly that field alongside `enrichedGist` (round-2 audit F4), so a
 * re-detailed scene kept serving its old answer.
 */
export function sceneStamp(row: {
  gist?: unknown;
  enrichedGist?: unknown;
  unexpectedDetails?: unknown;
}): string {
  const details = Array.isArray(row.unexpectedDetails)
    ? row.unexpectedDetails.map((d) => String(d)).join('\u001f')
    : '';
  return createHash('sha256')
    .update(`${String(row.gist ?? '')}\n${String(row.enrichedGist ?? '')}\n${details}`)
    .digest('hex')
    .slice(0, 16);
}

/** A DB `option<array<string>>` column as the pure gates want it. */
function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((e) => String(e)) : undefined;
}
