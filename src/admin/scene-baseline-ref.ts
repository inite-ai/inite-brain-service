import { StringRecordId } from 'surrealdb';

/**
 * `baselineRef` (migration 0106, FLEXIBLE) — ONE column, TWO producers,
 * now NAMESPACED.
 *
 * THE COLLISION. Two independent passes write this column with different
 * shapes and different meanings:
 *
 *   A. THE EXPECTATION SNAPSHOT (scene-prediction-baseline.ts,
 *      `baselineRefPayload`, under SCENES_PREDICTION_BASELINE): what the
 *      system believed BEFORE the scene was scored —
 *      `{beliefs, stampedAt, baselineVersion}`. Written by the enrichment
 *      pass, forward-looking, the audit trail for a MEASURED surprise.
 *
 *   B. THE REVISION BACKPOINTER (belief promotion, this file's
 *      `stampSupersededFrom`): the belief revision a promoted delta was
 *      applied AGAINST — `{belief, revision, value, stampedAt}`. Written
 *      only on a REVISION, only onto the scenes carrying the winning
 *      value, backward-looking.
 *
 * Both used to write the WHOLE column, so a promotion run after an
 * enrichment run destroyed the expectation snapshot and a re-enrichment
 * destroyed the backpointer. #473's author flagged exactly this and left
 * the fix to the promotion side; this is it.
 *
 * THE SHAPE. Two named sections under the same column:
 *
 *     baselineRef: {
 *       expectation:    { beliefs, stampedAt, baselineVersion },
 *       supersededFrom: { belief, revision, value, stampedAt },
 *     }
 *
 * Sections are written INDEPENDENTLY and only when they exist — a scene
 * with no expectation carries no `expectation` key at all, never a null.
 *
 * THE READING RULE (migration-free, tolerant of every shape ever
 * written). `readSceneBaselineRef` is ADDITIVE, not a discriminating
 * if/else chain:
 *   1. the namespaced keys `expectation` / `supersededFrom` are read
 *      first, each validated by its own shape test;
 *   2. any section still empty is then filled from the TOP LEVEL, where
 *      the two legacy shapes live: a `beliefs` array means legacy-A (an
 *      expectation), a string `belief` means legacy-B (a backpointer).
 * Because step 2 fills only what step 1 left empty, a namespaced row is
 * never re-read as legacy, and a HYBRID row (legacy fields at the top
 * level plus one namespaced key — what a nested `SET baselineRef.x`
 * would leave behind) reads correctly too. Nothing is migrated: the
 * column is FLEXIBLE, old rows keep their bytes and read fine, and the
 * next promotion revision rewrites a legacy-A row into the namespaced
 * shape WITHOUT losing the snapshot it found.
 *
 * WHAT THIS DOES NOT FIX. The enrichment pass still writes the whole
 * column (`baselineRef = $baselineRef`), so a RE-ENRICHMENT of an
 * already-promoted scene still drops `supersededFrom`. That writer lives
 * in scene-enricher.service.ts and is out of scope here; the loss is
 * benign and self-healing — the backpointer is provenance for a revision
 * that is still fully recorded on the belief chain itself (`priorValue`,
 * `supersededBy`, `validUntil`, and the `contradicted_by` / `derived_from`
 * support edges). The direction that destroyed IRREPLACEABLE data — a
 * promotion eating the pre-scene world model, which nothing else records
 * — is the one closed here.
 *
 * 3.2.4 DISCIPLINE. The read is a plain SELECT and every write is
 * PRIMARY-KEY addressed (`UPDATE $scene`), so neither goes anywhere near
 * the secondary-index planner class that makes `UPDATE/DELETE ... WHERE`
 * over an indexed field a silent no-op.
 */

/** The expectation snapshot the enrichment pass stamps (#473). */
export interface SceneExpectationRef {
  beliefs: unknown[];
  stampedAt?: string;
  baselineVersion?: string;
}

/** The belief revision a promoted delta was applied against. */
export interface BeliefSupersededRef {
  belief: string;
  revision: number;
  value: string;
  stampedAt: string;
}

/** Both sections of a baselineRef, normalized out of ANY stored shape. */
export interface SceneBaselineRefSections {
  expectation: SceneExpectationRef | null;
  supersededFrom: BeliefSupersededRef | null;
}

/** The one db surface this module needs (mock-swappable in tests). */
export interface BaselineRefDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

/** Pure: a plain (non-array, non-null) object, or null. */
function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Pure: an expectation snapshot, or null. The discriminator is the
 * `beliefs` ARRAY — the one field legacy-A always carries and legacy-B
 * never does. `stampedAt` / `baselineVersion` ride along only when they
 * are strings, so a half-written row degrades instead of throwing.
 */
function asExpectation(raw: unknown): SceneExpectationRef | null {
  const obj = asObject(raw);
  if (obj === null || !Array.isArray(obj.beliefs)) return null;
  return {
    beliefs: [...obj.beliefs],
    ...(typeof obj.stampedAt === 'string' ? { stampedAt: obj.stampedAt } : {}),
    ...(typeof obj.baselineVersion === 'string' ? { baselineVersion: obj.baselineVersion } : {}),
  };
}

/**
 * Pure: a revision backpointer, or null. The discriminator is a STRING
 * `belief` (a record-id string) plus a finite `revision` — legacy-A has
 * neither. `value` degrades to '' rather than rejecting the section.
 */
function asSuperseded(raw: unknown): BeliefSupersededRef | null {
  const obj = asObject(raw);
  if (obj === null || typeof obj.belief !== 'string' || obj.belief === '') return null;
  if (typeof obj.revision !== 'number' || !Number.isFinite(obj.revision)) return null;
  return {
    belief: obj.belief,
    revision: obj.revision,
    value: typeof obj.value === 'string' ? obj.value : '',
    stampedAt: typeof obj.stampedAt === 'string' ? obj.stampedAt : '',
  };
}

/**
 * Pure: normalize ANY stored `baselineRef` into its two sections —
 * namespaced, legacy-A (expectation), legacy-B (backpointer), the hybrid
 * of a namespaced key beside legacy top-level fields, and junk (both
 * null). See the reading rule in the header: namespaced keys first, top
 * level fills only what they left empty.
 */
export function readSceneBaselineRef(raw: unknown): SceneBaselineRefSections {
  const obj = asObject(raw);
  if (obj === null) return { expectation: null, supersededFrom: null };
  return {
    expectation: asExpectation(obj.expectation) ?? asExpectation(obj),
    supersededFrom: asSuperseded(obj.supersededFrom) ?? asSuperseded(obj),
  };
}

/**
 * Pure: the namespaced payload to store. Absent sections are OMITTED, not
 * nulled — a scene that only ever had an expectation keeps a
 * single-keyed object, and `{}` is never written for a scene with
 * neither.
 */
export function namespacedBaselineRef(sections: SceneBaselineRefSections): Record<string, unknown> {
  return {
    ...(sections.expectation !== null ? { expectation: sections.expectation } : {}),
    ...(sections.supersededFrom !== null ? { supersededFrom: sections.supersededFrom } : {}),
  };
}

/**
 * Pure: the merge belief promotion performs — stamp `supersededFrom`
 * while PRESERVING whatever expectation the column already held, in
 * whichever of the tolerated shapes it was written.
 */
export function mergeSupersededFrom(
  existing: unknown,
  ref: BeliefSupersededRef,
): Record<string, unknown> {
  return namespacedBaselineRef({
    expectation: readSceneBaselineRef(existing).expectation,
    supersededFrom: ref,
  });
}

/**
 * Stamp the revision backpointer onto the consumed scenes without
 * clobbering their expectation snapshots.
 *
 * READ-THEN-WRITE, deliberately. The old one-statement
 * `UPDATE ... SET baselineRef = $ref WHERE id INSIDE $ids` was exactly
 * the clobber; SurrealDB cannot merge a FLEXIBLE object against its own
 * prior value in one statement without a sub-key `SET` (which would leave
 * the hybrid shape rather than the namespaced one). So: ONE bounded
 * SELECT over the primary keys, then one primary-key `UPDATE $scene` per
 * scene that actually exists. The fan-out is bounded by the scenes
 * carrying ONE belief's winning value, and it only runs on a REVISION —
 * the rarest branch of the pass, not the per-scene hot path.
 *
 * Scenes in `sceneIds` that no longer exist are silently skipped: the
 * batch UPDATE they replaced no-oped for them too.
 *
 * Returns the number of scenes stamped (the caller's audit counter).
 */
export async function stampSupersededFrom(p: {
  db: BaselineRefDb;
  sceneIds: readonly string[];
  ref: BeliefSupersededRef;
}): Promise<number> {
  if (p.sceneIds.length === 0) return 0;
  const [rows] = await p.db.query<[Array<{ id: unknown; baselineRef?: unknown }>]>(
    `SELECT id, baselineRef FROM memory_episode WHERE id INSIDE $sceneIds`,
    { sceneIds: p.sceneIds.map((id) => new StringRecordId(id)) },
  );
  const existing = new Map<string, unknown>();
  for (const row of rows ?? []) existing.set(String(row.id), row.baselineRef);
  let stamped = 0;
  // Iterate the CALLER's order, not the read's — deterministic writes.
  for (const sceneId of p.sceneIds) {
    if (!existing.has(sceneId)) continue;
    await p.db.query(`UPDATE $scene SET baselineRef = $ref`, {
      scene: new StringRecordId(sceneId),
      ref: mergeSupersededFrom(existing.get(sceneId), p.ref),
    });
    stamped += 1;
  }
  return stamped;
}
