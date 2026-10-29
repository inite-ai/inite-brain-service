import { createHash } from 'node:crypto';

/**
 * What a rebuilt scene inherits from the scene it replaces.
 *
 * `composeConversation` swaps a conversation's whole scene set — delete,
 * insert — every time the conversation settles, and the fresh rows carried
 * nothing the post-swap passes had paid for. The enricher then called the
 * model again for EVERY scene of the conversation, not the one new turn's
 * scene: a long session settling four times paid for its history four
 * times (LLM spend audit, 2026-10-28). Belief promotion likewise lost its
 * `consolidatedInto` link and could synthesize again.
 *
 * A scene whose id, member turns and gist are unchanged IS the same scene:
 * it keeps those fields. Anything else is new and is paid for once.
 */
export const CARRIED_SCENE_FIELDS = [
  'enrichedGist',
  'enrichedMemoryValue',
  'stateDeltas',
  'unexpectedDetails',
  'enrichmentModel',
  'enrichmentVersion',
  'enrichedAt',
  'baselineRef',
  'entityIds',
  'gistEmbedding',
  'embeddingSpaceId',
  'encoderVersion',
  'consolidatedInto',
] as const;

/** Order-sensitive identity of a scene's member turns. */
export function sceneMemberHash(turnIds: readonly string[]): string {
  return createHash('sha256').update(turnIds.join('\n')).digest('hex').slice(0, 32);
}

export interface PriorScene {
  id: unknown;
  gist?: unknown;
  source?: { memberHash?: unknown; [k: string]: unknown } | null;
  [field: string]: unknown;
}

/**
 * Copy the carried fields from each prior scene onto the new row with the
 * same id, when its members and gist match. Only defined, non-null values
 * are copied: the table is SCHEMAFULL and an `option<…>` field refuses NULL.
 * Returns how many rows inherited.
 */
export function carrySceneEnrichment(
  rows: Array<Record<string, unknown>>,
  prior: readonly PriorScene[],
): number {
  const byId = new Map(prior.map((p) => [String(p.id), p]));
  let carried = 0;
  for (const row of rows) {
    const old = byId.get(String(row.id));
    const memberHash = (row.source as { memberHash?: unknown } | undefined)?.memberHash;
    if (!old || memberHash === undefined) continue;
    if (old.source?.memberHash !== memberHash || old.gist !== row.gist) continue;
    for (const f of CARRIED_SCENE_FIELDS) {
      const v = old[f];
      if (v !== undefined && v !== null) row[f] = v;
    }
    carried += 1;
  }
  return carried;
}
