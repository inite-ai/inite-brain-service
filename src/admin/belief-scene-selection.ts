import type { Logger } from '@nestjs/common';
import type { BeliefPromotionResult } from './belief-promotion.service';
import { formatValueDims, sceneValueVerdict } from './belief-value-gate';

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

/** Scene head as selected by the promotion query (validated in JS). */
export interface PromotableSceneHead {
  id: unknown;
  userId?: unknown;
  userIds?: unknown;
  conversationIds?: unknown;
  occurredTo?: unknown;
  stateDeltas?: unknown;
  /** enrichedMemoryValue.explicitness projection (confidence signal). */
  explicitness?: unknown;
  /**
   * enrichedMemoryValue value-vector projections read by the memory-value
   * gate. Selected ONLY under SCENES_VALUE_GATE_ENABLED (the flag-off
   * query is byte-identical), so with the gate off they are always
   * undefined — which the gate reads as "unknown", never as zero.
   */
  novelty?: unknown;
  contradiction?: unknown;
  stateChange?: unknown;
  /**
   * The scene world this row belongs to. Selected ONLY under
   * SCENES_PACK_DELTA_PROMOTION (the flag-off query is byte-identical),
   * where it becomes the belief's pack provenance.
   */
  segmenterVersion?: unknown;
}

/**
 * Pure: the single user a scene's beliefs may inherit, or null when the
 * scene must be skipped fail-closed (#387): userIds missing (legacy),
 * empty (tenant-global), longer than one (mixed group), or disagreeing
 * with the folded userId stamp.
 *
 * Lives beside the query that produces the row it fences (and is
 * re-exported from belief-promotion.service.ts, so every historical
 * import site — the enricher, the prediction baseline, the specs — is
 * unchanged). A duplicated scope fence is a fence that drifts.
 */
export function sceneSingleUser(scene: PromotableSceneHead): string | null {
  const userIds = scene.userIds;
  if (!Array.isArray(userIds) || userIds.length !== 1) return null;
  const only = userIds[0];
  if (typeof only !== 'string' || only === '') return null;
  if (scene.userId !== only) return null;
  return only;
}

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
 * Pure: the extra value-vector projections the memory-value gate needs
 * (SCENES_VALUE_GATE_ENABLED). OFF returns the empty string, so the
 * caller's template is byte-identical to the pre-gate SQL — the gate
 * does not even LOOK at the vector unless it is on. `indent` keeps the
 * appended lines aligned with the leg they join (the two legs are
 * indented differently).
 *
 * `explicitness` is deliberately NOT here: it is projected
 * unconditionally because the confidence fold has always consumed it.
 */
function valueDimProjections(on: boolean, indent: string): string {
  if (!on) return '';
  return (
    `,\n${indent}enrichedMemoryValue.novelty AS novelty,` +
    `\n${indent}enrichedMemoryValue.contradiction AS contradiction,` +
    `\n${indent}enrichedMemoryValue.stateChange AS stateChange`
  );
}

/**
 * Pure: the promotion pass's scene selection.
 *
 * FLAG OFF (default) the SQL string and the bind map are byte-identical
 * to the pre-SCENES_PACK_DELTA_PROMOTION pass — pinned by unit test,
 * because "off is byte-identical" is the whole contract of a shadow
 * substrate flag. The same holds for SCENES_VALUE_GATE_ENABLED: off, the
 * value dimensions are not projected at all.
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
  valueGate?: boolean;
  /**
   * The full-chain read of a targeted run (F6): every promotable scene
   * that involves these users, whatever conversation it came from, so a
   * late-arriving scene is folded at its place in the whole chain rather
   * than judged against the head alone. Undefined ⇒ no user clause —
   * the SQL is byte-identical to the historical selection.
   */
  userIds?: readonly string[] | undefined;
}): { sql: string; params: Record<string, unknown> } {
  const conv = p.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : '';
  const users = p.userIds !== undefined ? ` AND userIds CONTAINSANY $users` : '';
  const gate = p.valueGate === true;
  const params: Record<string, unknown> = {
    v: p.version,
    ...(p.conversationId !== undefined ? { conv: p.conversationId } : {}),
    ...(p.userIds !== undefined ? { users: [...p.userIds] } : {}),
  };
  if (!p.packDeltas) {
    const dims = valueDimProjections(gate, ' '.repeat(16));
    return {
      sql:
        `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness${dims}
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE` +
        conv +
        users,
      params,
    };
  }
  const dims = valueDimProjections(gate, ' '.repeat(14));
  return {
    sql:
      `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas, segmenterVersion,
              enrichedMemoryValue.explicitness AS explicitness${dims}
         FROM memory_episode
        WHERE ((segmenterVersion = $v AND enrichmentVersion IS NOT NONE)
            OR (string::starts_with(segmenterVersion, $packPrefix)
                AND stateDeltas IS NOT NONE AND array::len(stateDeltas) > 0))` +
      conv +
      users,
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

/**
 * The per-scene admission fences, in order: #387 single-user (a security
 * fence is never traded against a quality one), then the memory-value
 * gate. `count` is the run summary for the batch being promoted; null
 * when the same fences are applied to the evidence chain a targeted run
 * re-reads (that chain is context, not this run's scenes — its skips
 * must not inflate the batch's counters).
 */
export function admitScenes({
  scenes,
  gate,
  count,
  logger,
}: {
  scenes: readonly PromotableSceneHead[];
  gate: { valueGate: boolean; valueGateMin: number };
  count: BeliefPromotionResult | null;
  logger: Logger;
}): Array<{ scene: PromotableSceneHead; userId: string }> {
  const eligible: Array<{ scene: PromotableSceneHead; userId: string }> = [];
  for (const scene of scenes) {
    if (count) count.scenes += 1;
    const userId = sceneSingleUser(scene);
    if (userId === null) {
      // #387 fail-closed: mixed-user, tenant-global or legacy (pre-0117
      // userIds) scenes never feed a belief.
      if (count) {
        count.skippedMixedUser += 1;
        logger.warn(
          `belief promotion skipped scene ${String(scene.id)}: not single-user ` +
            `(userIds=${JSON.stringify(scene.userIds ?? null)}) — #387 fence`,
        );
      }
      continue;
    }
    // MEMORY-VALUE GATE: the value vector's first consumer. Runs AFTER the
    // #387 fence and BEFORE the fold, so a refused scene contributes no
    // delta at all. Off ⇒ not even evaluated.
    if (gate.valueGate) {
      const verdict = sceneValueVerdict(scene, gate.valueGateMin);
      if (!verdict.promote) {
        if (count) {
          count.skippedLowValue += 1;
          logger.log(
            `belief promotion value gate: scene ${String(scene.id)} skipped as noise ` +
              `(${formatValueDims(verdict.dims)}; all < ${gate.valueGateMin}) — ` +
              `SCENES_VALUE_GATE_ENABLED`,
          );
        }
        continue;
      }
    }
    if (count) count.eligibleScenes += 1;
    eligible.push({ scene, userId });
  }
  return eligible;
}
