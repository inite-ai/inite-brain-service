/**
 * Pack-scoped view over a tenant's predicate snapshot — the vocabulary a
 * DEDICATED indexer run extracts with: only that pack's predicates (plus,
 * by default, the unprefixed core set — entity typing and generic facts
 * need the core cards), only that pack's extraction profile.
 *
 * Derived from the ALREADY-CACHED tenant snapshot — no DB reads. The
 * filtered versionHash is a stable sub-hash of (full hash, packId, core
 * flag) so the extraction cache keys dedicated runs separately from the
 * union run and from each other.
 *
 * Pure module — unit-testable without a DB.
 */
import { createHash } from 'node:crypto';
import { PACK_NAMESPACE_SEP } from '../ai/domain-packs/manifest';
import type {
  PackExtractionProfile,
  PredicateSnapshot,
} from '../ai/predicate-registry-internals/types';

export function filterSnapshotForPack(
  full: PredicateSnapshot,
  opts: { packId: string; includeCorePredicates?: boolean | undefined },
): PredicateSnapshot {
  const includeCore = opts.includeCorePredicates !== false;
  const prefix = opts.packId + PACK_NAMESPACE_SEP;
  const keep = (predicateId: string) =>
    predicateId.startsWith(prefix) ||
    (includeCore && !isPackNamespaced(predicateId));

  const active = full.active.filter((p) => keep(p.predicateId));
  const byId = new Map(active.map((p) => [p.predicateId, p] as const));
  // Aliases only survive when their canonical target survives — a chain
  // pointing outside the pack view would resolve to a missing predicate.
  const aliasMap = new Map(
    [...full.aliasMap].filter(([, canonical]) => byId.has(canonical)),
  );
  const embeddings = new Map(
    [...full.embeddings].filter(([predicateId]) => byId.has(predicateId)),
  );
  const extractionProfiles: PackExtractionProfile[] = (
    full.extractionProfiles ?? []
  ).filter((p) => p.packId === opts.packId);

  const versionHash = createHash('sha256')
    .update(
      `${full.versionHash}:${opts.packId}:${includeCore ? 'core' : 'nocore'}`,
    )
    .digest('hex')
    .slice(0, 16);

  return { versionHash, active, byId, aliasMap, embeddings, extractionProfiles };
}

function isPackNamespaced(predicateId: string): boolean {
  return predicateId.indexOf(PACK_NAMESPACE_SEP) > 0;
}
