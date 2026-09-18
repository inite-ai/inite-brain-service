/**
 * The dependency arms of a cached answer (0136, audit F3; 0152 adds the
 * relation arm): the non-fact evidence a cached answer rests on, how each
 * kind is read back, stamped, fenced and lifecycle-gated on every read.
 * Pure module — no DI, no IO; the service owns the queries.
 */
import { isRecordId, toMs } from './record-id';
import {
  beliefLaneVisible,
  beliefStamp,
  episodeStamp,
  episodeVisible,
  fragmentStamp,
  fragmentVisible,
  sceneStamp,
  sceneVisible,
  type EvidenceFences,
} from '../synthesize/evidence-visibility';
import type { EvidenceCitation } from '../synthesize/synthesize.types';
import type { Citation } from '../synthesize/fact-index';

/** Mirrors the migration-0091/0097/0136 ASSERT on
 *  answer_cache.invalidationCause. `newer_fact` (0097) = the additive-write
 *  freshness cause: a NEW active fact appeared on a cited entity after the
 *  answer was built. `dependency_changed` (0136) = a non-fact dependency's
 *  lifecycle stamp moved while its row stayed servable (a belief revised in
 *  place, a scene recomposed, an asset's quarantine state changed). */
export type InvalidationCause =
  'superseded' | 'retracted' | 'expired_validity' | 'missing' | 'newer_fact' | 'dependency_changed';

/**
 * The non-fact evidence a cached answer rests on (0136, audit F3) — one
 * entry per EvidenceCitation arm, in the order the arms are declared.
 * Every kind here is revalidated on EVERY read; an arm this list does not
 * name is untrackable, and an answer citing one is never admitted.
 */
export type CachedDependencyKind = 'belief' | 'episode' | 'fragment' | 'scene' | 'edge';

export interface CachedDependency {
  kind: CachedDependencyKind;
  /** Full record id — `semantic_belief:…`, `episode:…`,
   *  `evidence_fragment:…`, `memory_episode:…`, `knowledge_edge:…`. */
  id: string;
  /**
   * Lifecycle stamp observed at admission, compared byte-for-byte on
   * read: a belief's `revision`, a scene's gist hash, a fragment's asset
   * quarantine state; '' for an episode (immutable text — existence IS
   * its lifecycle) and for an edge (immutable record — `invalidatedAt`
   * is its lifecycle). A changed stamp is `dependency_changed`.
   */
  rev: string;
}

export const DEPENDENCY_KINDS: readonly CachedDependencyKind[] = [
  'belief',
  'episode',
  'fragment',
  'scene',
  'edge',
];

/** A dependency row as the per-kind SELECT returns it (see dependencySelect). */
export interface DependencyRow {
  id: unknown;
  userId?: string | null;
  revision?: number | string | null;
  status?: string | null;
  supersededBy?: unknown;
  validUntil?: Date | string | null;
  quarantineStatus?: string | null;
  gist?: string | null;
  enrichedGist?: string | null;
  unexpectedDetails?: unknown;
  /** Visibility-fence columns — see the per-kind predicates in
   *  synthesize/evidence-visibility.ts. */
  userIds?: unknown;
  piiClass?: unknown;
  piiClasses?: unknown;
  segmenterVersion?: unknown;
  assetUserId?: unknown;
  assetAvailability?: unknown;
  /** Edge columns — the relation citation is rebuilt from them on read. */
  invalidatedAt?: Date | string | null;
  kind?: string | null;
  in?: unknown;
  fromName?: string | null;
  toName?: string | null;
}

/**
 * The typed dependency set of a result's evidence citations, or null when
 * a citation carries no arm this cache can revalidate (the ONE-OF
 * invariant means exactly one id is present on a well-formed citation;
 * a malformed one is untrackable and blocks admission — fail closed).
 * De-duplicated per (kind, id); kind order is the declared arm order.
 */
export function dependenciesOf(
  evidenceCitations: EvidenceCitation[] | undefined,
): Array<Pick<CachedDependency, 'kind' | 'id'>> | null {
  const out: Array<Pick<CachedDependency, 'kind' | 'id'>> = [];
  const seen = new Set<string>();
  for (const c of evidenceCitations ?? []) {
    const dep = dependencyArm(c);
    if (!dep) return null;
    const key = `${dep.kind}|${dep.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out.sort((a, b) => DEPENDENCY_KINDS.indexOf(a.kind) - DEPENDENCY_KINDS.indexOf(b.kind));
}

export function dependencyArm(c: EvidenceCitation): Pick<CachedDependency, 'kind' | 'id'> | null {
  if (isRecordId(c.beliefId)) return { kind: 'belief', id: c.beliefId };
  if (isRecordId(c.episodeId)) return { kind: 'episode', id: c.episodeId };
  if (isRecordId(c.fragmentId)) return { kind: 'fragment', id: c.fragmentId };
  if (isRecordId(c.sceneId)) return { kind: 'scene', id: c.sceneId };
  return null;
}

/** The id-only evidence citation a served hit returns for a dependency —
 *  the arm the answer was admitted with, nothing rendered. */
export function citationOfDependency(dep: CachedDependency): EvidenceCitation | null {
  switch (dep.kind) {
    case 'belief':
      return { beliefId: dep.id };
    case 'episode':
      return { episodeId: dep.id };
    case 'fragment':
      return { fragmentId: dep.id };
    case 'scene':
      return { sceneId: dep.id };
    case 'edge':
      // A relation is a citation, not an evidence arm — rebuilt from its
      // live row beside the cited facts (see edgeCitation).
      return null;
  }
}

/** The relation citation a served hit returns, from the edge's live row
 *  (the fact-index.ts relationEntry shape: subject, kind, peer). */
export function edgeCitation(id: string, row: DependencyRow): Citation {
  return {
    factId: id,
    entityId: String(row.in ?? ''),
    canonicalName: row.fromName ?? '',
    predicate: row.kind ?? '',
    slot: `edge:${row.kind ?? ''}`,
    object: row.toName ?? '',
  };
}

/** A stored dependency entry as the 0136 ASSERTs shape it; anything else
 *  is a malformed row and fails closed on read. */
export function isCachedDependency(v: unknown): v is CachedDependency {
  if (v === null || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.kind === 'string' &&
    (DEPENDENCY_KINDS as readonly string[]).includes(d.kind) &&
    isRecordId(d.id) &&
    typeof d.rev === 'string'
  );
}

/**
 * One SELECT per kind, bound on `$<kind>` (a record-id array). The
 * projection is exactly what `dependencyRev` and `dependencyLifecycle`
 * read PLUS every column the serving lane's visibility fence reads
 * (round-2 audit F1): the stamp alone said nothing about media PII,
 * modality consent, asset ownership, availability, text PII, scene
 * membership or the live scene world, so re-checking only the stamp
 * served closed evidence to a key that never held the scope. Nothing
 * content-bearing leaves the DB — piiClasses/piiClass are
 * classifications, not content.
 */
export function dependencySelect(kind: CachedDependencyKind): string {
  switch (kind) {
    case 'belief':
      return `SELECT id, revision, status, supersededBy, validUntil, userId
                FROM semantic_belief WHERE id INSIDE $belief`;
    case 'episode':
      return `SELECT id, userId, piiClass FROM episode WHERE id INSIDE $episode`;
    case 'fragment':
      // The fragment row is immutable; its parent asset's quarantine
      // state is the lifecycle (a rejected asset must not keep serving
      // through a cached answer). A dangling asset link reads as NONE.
      return `SELECT id, piiClasses,
                     assetId.quarantineStatus AS quarantineStatus,
                     assetId.userId AS assetUserId,
                     assetId.availability AS assetAvailability
                FROM evidence_fragment WHERE id INSIDE $fragment`;
    case 'scene':
      return `SELECT id, gist, enrichedGist, unexpectedDetails, userId, userIds,
                     piiClass, segmenterVersion
                FROM memory_episode WHERE id INSIDE $scene`;
    case 'edge':
      return `SELECT id, invalidatedAt, userId, kind, in,
                     in.canonicalName AS fromName, out.canonicalName AS toName
                FROM knowledge_edge WHERE id INSIDE $edge`;
  }
}

/** The stamp that must not move for the cached answer to stay valid —
 *  the SAME functions the serving lanes stamp their rendered rows with. */
export function dependencyRev(kind: CachedDependencyKind, row: DependencyRow): string {
  switch (kind) {
    case 'belief':
      return beliefStamp(row);
    case 'episode':
      return episodeStamp();
    case 'fragment':
      return fragmentStamp(row);
    case 'scene':
      return sceneStamp(row);
    case 'edge':
      return '';
  }
}

/** Kinds whose stamp can move under a running request — the ones the
 *  retrieval snapshot has to cover (round-2 audit F4). An episode's text
 *  is immutable, so its stamp is constant and needs no snapshot. */
export const MUTABLE_DEPENDENCY_KINDS: readonly CachedDependencyKind[] = [
  'belief',
  'fragment',
  'scene',
];

/**
 * The serving lane's OWN per-row visibility fence, re-applied to a
 * dependency row (round-2 audit F1). False = invisible to this caller,
 * which reads as 'missing' — existence never leaks. This is the half a
 * lifecycle stamp cannot carry: revoking modality consent, reclassifying
 * a fragment's piiClasses, stamping a scene's piiClass, promoting a new
 * scene world or erasing an asset's bytes all leave every stamp intact.
 */
export function dependencyVisible(
  kind: CachedDependencyKind,
  row: DependencyRow,
  fences: EvidenceFences,
): boolean {
  const { caller, world } = fences;
  switch (kind) {
    case 'belief':
      return beliefLaneVisible(row, caller);
    case 'episode':
      return episodeVisible(row, caller);
    case 'fragment':
      return fragmentVisible(row, caller, world);
    case 'scene':
      return sceneVisible(row, caller, world);
    case 'edge':
      // The edge fence (search/internals/edge-fence.ts): tenant-global,
      // or the caller's own.
      return row.userId == null || row.userId === caller.userId;
  }
}

/**
 * The lifecycle gate a dependency row must pass to be servable — the
 * cited-fact gate's counterpart per kind. Null = servable. The scope
 * fences live in `dependencyVisible`, which runs first.
 *
 * A belief never reads 'retracted': migration 0120 asserts
 * `status INSIDE ['active','superseded']`, so retraction is not a state a
 * belief can reach (a value change is a new revision). The cause stays in
 * the typed union because a retracted cited FACT still emits it.
 */
export function dependencyLifecycle(
  kind: CachedDependencyKind,
  row: DependencyRow,
): InvalidationCause | null {
  if (kind === 'belief') {
    if (
      row.status === 'superseded' ||
      (row.supersededBy !== undefined && row.supersededBy !== null)
    ) {
      return 'superseded';
    }
    if (row.status !== 'active') return 'missing';
    if (row.validUntil && toMs(row.validUntil) <= Date.now()) return 'expired_validity';
  }
  if (kind === 'fragment' && row.quarantineStatus === 'rejected') return 'missing';
  if (kind === 'edge' && row.invalidatedAt != null) return 'superseded';
  return null;
}
