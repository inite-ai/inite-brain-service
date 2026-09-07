/**
 * Which scenes the belief promotion pass reads, and which world stamp a
 * promoted belief carries (the god-file split off
 * belief-promotion.service.ts — the belief-field-fold.ts precedent; the
 * service re-exports every name here, so the historical import surface is
 * unchanged).
 *
 * Two id-spaces feed the belief plane:
 *  - the COMPOSER's effective segmenter world (`scene-segmenter-v1`,
 *    optionally fingerprinted under SCENES_VERSION_FINGERPRINT), whose
 *    scenes are LLM-enriched;
 *  - the PACK PROJECTION worlds (`pack:<packId>+<fp>`, packSceneVersion
 *    in episodes/pack-scene-projection.ts), whose stateDeltas come from a
 *    pack's own reading of a document or of a captured turn — both
 *    origins write the one shared shape, including the belief `field`.
 * The prefixes are disjoint by construction, which is what lets one
 * WHERE serve both without an ambiguity.
 */

/** Promoter identity — composed with the effective scene world below. */
export const BELIEF_PROMOTER_VERSION = 'belief-promotion-v1';

/**
 * Pure: the readable promoter|world composite stamped on belief rows and
 * support edges (the enricher's readable-composite idiom — NOT hashed).
 */
export function beliefPromoterVersion(sceneVersion: string): string {
  return `${BELIEF_PROMOTER_VERSION}|${sceneVersion}`;
}

/** Namespace prefix of a pack-projection scene world. */
export const PACK_SCENE_WORLD_PREFIX = 'pack:';

/** Pure: does this scene world belong to a pack projection? */
export function isPackSceneWorld(world: string): boolean {
  return world.startsWith(PACK_SCENE_WORLD_PREFIX);
}

/**
 * Pure: the promotion pass's scene selection.
 *
 * FLAG OFF (default) the SQL string and the bind map are byte-identical
 * to the pre-SCENES_PACK_DELTA_PROMOTION pass — pinned by unit test,
 * because "off is byte-identical" is the whole contract of a shadow
 * substrate flag.
 *
 * FLAG ON a second leg admits the pack-projection worlds. That leg
 * deliberately does NOT require `enrichmentVersion`: a pack scene's
 * stateDeltas come from the pack indexer's reading, not from the LLM
 * enricher, so the enrichment stamp it will never have must not fence it
 * out. It DOES require a non-empty `stateDeltas` array — a scene with
 * nothing to promote is not worth loading — and the SELECT gains
 * `segmenterVersion` so each contribution knows which world it came from
 * (belief provenance, promoterVersionFor below).
 *
 * Both legs are plain reads: the SurrealDB 3.2.4 secondary-index
 * DELETE/UPDATE-WHERE planner trap applies to writes, not to SELECT.
 */
export function buildPromotableScenesQuery(p: {
  version: string;
  conversationId?: string | undefined;
  packDeltas: boolean;
}): { sql: string; params: Record<string, unknown> } {
  const conv = p.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : '';
  const params: Record<string, unknown> = {
    v: p.version,
    ...(p.conversationId !== undefined ? { conv: p.conversationId } : {}),
  };
  if (!p.packDeltas) {
    return {
      sql:
        `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE` + conv,
      params,
    };
  }
  return {
    sql:
      `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas, segmenterVersion,
              enrichedMemoryValue.explicitness AS explicitness
         FROM memory_episode
        WHERE ((segmenterVersion = $v AND enrichmentVersion IS NOT NONE)
            OR (string::starts_with(segmenterVersion, $packPrefix)
                AND stateDeltas IS NOT NONE AND array::len(stateDeltas) > 0))` + conv,
    params: { ...params, packPrefix: PACK_SCENE_WORLD_PREFIX },
  };
}

/**
 * Pure: the promoterVersion stamped on ONE belief.
 *
 * Provenance without a new column (0120 is SCHEMAFULL and this ships no
 * migration): a belief folded entirely out of ONE pack-projection world
 * is stamped `belief-promotion-v1|pack:<packId>+<fp>` instead of the
 * run's composer world, so `SELECT promoterVersion FROM semantic_belief`
 * alone says which pack's perception produced the row — and the
 * pack-namespaced `field` says it a second time.
 *
 * Every other case keeps the run stamp verbatim: no worlds (the flag-off
 * path never selects the column), a composer world, or a MIXED set (a
 * belief corroborated by both planes belongs to neither alone). So with
 * SCENES_PACK_DELTA_PROMOTION off this is the identity function on
 * runPromoterVersion — byte-identical stamps.
 */
export function promoterVersionFor(
  belief: { worlds: readonly string[] },
  runPromoterVersion: string,
): string {
  const only = belief.worlds.length === 1 ? belief.worlds[0] : undefined;
  return only !== undefined && isPackSceneWorld(only)
    ? beliefPromoterVersion(only)
    : runPromoterVersion;
}
