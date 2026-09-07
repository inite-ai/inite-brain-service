import { resolveFieldFold } from './belief-field-fold';
import { sceneSingleUser, type PromotableSceneHead } from './belief-promotion.service';
import type { SceneTurnRow } from './scene-segmentation';

/**
 * Scene PREDICTION BASELINE (SCENES_PREDICTION_BASELINE, default off):
 * the expectation snapshot the scene plane never had.
 *
 * THE GAP THIS CLOSES. `memoryValue.contradiction` and
 * `unexpectedDetails` were pure LLM saliency guesses — the enricher was
 * never shown ANY prior state to be surprised AGAINST, so "surprising"
 * meant "vivid", not "deviant". `baselineRef` (0106) existed but was
 * written only by belief promotion, only on a revision, AFTER the fact —
 * a provenance backpointer, not an expectation. The roadmap names the
 * hole exactly: "The missing edge is PREDICTION as a read-side control
 * signal (surprise currently exists only at write time)"
 * (docs/roadmap/memory-research-2026-08.md).
 *
 * WHAT A BASELINE IS. The tenant/user's ACTIVE `semantic_belief` rows
 * (0120) for the subjects THIS scene is about, read BEFORE the scene is
 * scored — literally "what the system believed before this happened".
 * It is rendered into the enrichment prompt (so the model reports
 * observed-vs-expected instead of free-floating saliency), measured
 * against the scene's stateDeltas by a deterministic scorer that costs
 * nothing, and stamped onto the scene as `baselineRef` so the
 * expectation is auditable after the fact.
 *
 * NEW FILE BY DESIGN. Belief READING for the scene plane lives here, not
 * inside belief-promotion.service.ts (the god-file ceiling that already
 * pushed belief-field-fold.ts out) and not inside the enricher (which
 * stays a transport/orchestration service). The two helpers imported
 * from the belief layer — `sceneSingleUser` (the #387 fail-closed
 * single-user fence) and `resolveFieldFold` (the deterministic lexical
 * field-name rule) — are IMPORTED, never re-implemented: a duplicated
 * scope fence is a fence that drifts.
 *
 * 3.2.4 DISCIPLINE. Exactly one plain SELECT per run (reads never trip
 * the compound-index planner class that makes `DELETE ... WHERE` a
 * silent no-op — see the 0093/0120 headers); no write here at all.
 *
 * TENANT / USER FENCE. Every read is inside `withCompany` (tenant) and
 * filtered to the userIds of scenes that PASSED `sceneSingleUser` — a
 * mixed-user, tenant-global or legacy (pre-0117 `userIds`) scene gets NO
 * baseline at all rather than a shared one. A scene is therefore never
 * scored against another user's beliefs; `assembleSceneBaseline` re-
 * applies the fence per scene so a wrong bucket cannot leak through the
 * map lookup either.
 */

/** Stamp of the deterministic prediction-error scorer defined below. */
export const SCENE_PREDICTION_SCORER_VERSION = 'scene-scorer-v1';

/** Stamp inside the `baselineRef` snapshot (its own shape version). */
export const SCENE_BASELINE_VERSION = 'scene-baseline-v1';

/**
 * BOUNDS (all documented, all deliberately small — a baseline is a
 * prompt block and a stamped snapshot, not a data dump):
 *  - QUERY_LIMIT caps the ONE per-run belief read; a tenant with more
 *    active beliefs than this simply gets a truncated (deterministically
 *    ordered) world model, never a slow query.
 *  - MAX_SUBJECTS / MAX_BELIEFS cap what any single scene renders and
 *    stamps, so prompt size and row size stay bounded regardless of how
 *    much the tenant believes.
 *  - VALUE_MAX_CHARS mirrors the enricher's DELTA_FIELD_MAX_CHARS so a
 *    belief value and a delta value are rendered on the same scale.
 */
export const BASELINE_QUERY_LIMIT = 2000;
export const BASELINE_MAX_SUBJECTS = 20;
export const BASELINE_MAX_BELIEFS = 40;
export const BASELINE_VALUE_MAX_CHARS = 200;

/**
 * `stateChange` saturation: deltas-per-member-turn at which the
 * dimension reaches 1. One durable transition every two turns is already
 * a dense state-change scene — above that the dimension saturates rather
 * than growing without bound.
 */
export const STATE_CHANGE_SATURATION_PER_TURN = 0.5;

/**
 * Self-subject markers for the `identity` dimension — a deliberately
 * small, documented heuristic (English + Russian), the same spirit as
 * the v0 scorer's FIRST_PERSON_PATTERNS in scene-segmentation.ts. A
 * delta whose subject normalizes into this set (or into the scene's own
 * userId / a non-assistant speaker label) is about the speaker
 * themselves.
 */
const SELF_SUBJECT_MARKERS: ReadonlySet<string> = new Set([
  'user',
  'the user',
  'i',
  'me',
  'myself',
  'speaker',
  'я',
  'мне',
  'пользователь',
]);

/** One ACTIVE belief as the baseline carries it. */
export interface BaselineBelief {
  id: string;
  subject: string;
  field: string;
  value: string;
  revision: number;
}

/** The `baselineRef` snapshot payload written onto the scene (0106). */
export interface SceneBaselineRef {
  beliefs: BaselineBelief[];
  stampedAt: string;
  baselineVersion: string;
}

/** Prediction-error dimensions — every one OPTIONAL by contract. */
export interface ScenePredictionError {
  contradiction?: number;
  stateChange?: number;
  identity?: number;
}

/** One scene stateDelta as the enricher parses it. */
export interface SceneStateDelta {
  subject: string;
  field: string;
  from: string;
  to: string;
}

/** The one db surface this module needs (mock-swappable in tests). */
export interface BaselineDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Pure: the lexical normalization used for every comparison here —
 * lowercase, punctuation to space, whitespace collapsed. This is exactly
 * what belief-field-fold.ts applies inside `fieldTokens` (which is not
 * exported and returns a token Set); kept as one string so subjects and
 * values compare as whole phrases. NO stemming, NO embeddings, NO fuzzy
 * distance — the belief layer's own rule, nothing invented.
 */
export function normalizeLexical(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t !== '')
    .join(' ');
}

/**
 * The ONE bounded belief read per enrichment run: every ACTIVE
 * semantic_belief of the given users, bucketed by userId. Same query
 * shape as the promotion pass's field-fold candidate read
 * (belief-promotion.service.ts) — `status = 'active' AND userId INSIDE
 * $userIds` — deliberately NOT a second idiom. Empty input ⇒ zero
 * queries.
 *
 * Ordering is total and deterministic (subject, field, revision desc,
 * id) so a truncation at BASELINE_QUERY_LIMIT always keeps the SAME
 * rows for the same data — a baseline that shifted under LIMIT would
 * make enrichment non-reproducible.
 */
export async function loadActiveBeliefBaseline(
  db: BaselineDb,
  userIds: readonly string[],
): Promise<Map<string, BaselineBelief[]>> {
  const buckets = new Map<string, BaselineBelief[]>();
  if (userIds.length === 0) return buckets;
  const [rows] = await db.query<
    [
      Array<{
        id: unknown;
        userId: unknown;
        subject: unknown;
        field: unknown;
        value: unknown;
        revision: unknown;
      }>,
    ]
  >(
    `SELECT id, userId, subject, field, value, revision FROM semantic_belief
      WHERE status = 'active' AND userId INSIDE $userIds
      ORDER BY subject ASC, field ASC, revision DESC, id ASC
      LIMIT $cap`,
    { userIds: [...userIds], cap: BASELINE_QUERY_LIMIT },
  );
  for (const row of rows ?? []) {
    const userId = str(row.userId);
    const subject = str(row.subject);
    const field = str(row.field);
    if (userId === '' || subject === '' || field === '') continue;
    const bucket = buckets.get(userId);
    const belief: BaselineBelief = {
      id: String(row.id),
      subject,
      field,
      value: str(row.value).slice(0, BASELINE_VALUE_MAX_CHARS),
      revision:
        typeof row.revision === 'number' && Number.isFinite(row.revision) ? row.revision : 0,
    };
    if (bucket === undefined) buckets.set(userId, [belief]);
    else bucket.push(belief);
  }
  return buckets;
}

/**
 * Pure: the normalized subject labels that mean "the speaker themselves"
 * for this scene — its single-user id, its non-assistant speaker labels
 * (the assistant lane never owns identity-central state), and the
 * documented SELF_SUBJECT_MARKERS.
 */
export function sceneSelfSubjects(
  userId: string | null,
  turns: readonly SceneTurnRow[],
): Set<string> {
  const self = new Set<string>(SELF_SUBJECT_MARKERS);
  if (userId !== null) {
    const norm = normalizeLexical(userId);
    if (norm !== '') self.add(norm);
  }
  for (const turn of turns) {
    const speaker = turn.speaker ?? '';
    if (speaker.toLowerCase().endsWith('assistant')) continue;
    const norm = normalizeLexical(speaker);
    if (norm !== '') self.add(norm);
  }
  return self;
}

/**
 * Pure: which of the user's ACTIVE beliefs this scene is ABOUT — the
 * subject candidates come from the scene itself (a belief subject named
 * in the transcript, or a self-subject), never from the model reply
 * (which does not exist yet at prompt-build time).
 *
 * Bounded twice: at most BASELINE_MAX_SUBJECTS distinct subjects and at
 * most BASELINE_MAX_BELIEFS rows, cut from a totally ordered list so the
 * same scene always renders the same block.
 */
export function assembleSceneBaseline(
  beliefs: readonly BaselineBelief[],
  transcript: string,
  selfSubjects: ReadonlySet<string>,
): BaselineBelief[] {
  if (beliefs.length === 0) return [];
  // Padded normalized transcript: a whole-phrase containment test that
  // cannot match across word interiors ('ana' inside 'banana').
  const haystack = ` ${normalizeLexical(transcript)} `;
  const relevant = beliefs.filter((b) => {
    const subject = normalizeLexical(b.subject);
    if (subject === '') return false;
    return selfSubjects.has(subject) || haystack.includes(` ${subject} `);
  });
  const ordered = [...relevant].sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) ||
      a.field.localeCompare(b.field) ||
      b.revision - a.revision ||
      a.id.localeCompare(b.id),
  );
  const subjects = new Set<string>();
  const out: BaselineBelief[] = [];
  for (const belief of ordered) {
    if (out.length >= BASELINE_MAX_BELIEFS) break;
    const subject = normalizeLexical(belief.subject);
    if (!subjects.has(subject)) {
      if (subjects.size >= BASELINE_MAX_SUBJECTS) continue;
      subjects.add(subject);
    }
    out.push(belief);
  }
  return out;
}

/**
 * Pure: the per-scene baseline, fenced. Returns null — NO baseline, no
 * prompt block, no measured dimensions — for any scene that fails the
 * #387 single-user fence, so a mixed-user / tenant-global / legacy scene
 * is never scored against one user's beliefs.
 */
export function sceneBaseline({
  scene,
  turns,
  transcript,
  beliefsByUser,
}: {
  scene: PromotableSceneHead;
  turns: readonly SceneTurnRow[];
  transcript: string;
  beliefsByUser: ReadonlyMap<string, BaselineBelief[]>;
}): { userId: string | null; beliefs: BaselineBelief[]; selfSubjects: Set<string> } {
  const userId = sceneSingleUser(scene);
  const selfSubjects = sceneSelfSubjects(userId, turns);
  if (userId === null) return { userId: null, beliefs: [], selfSubjects };
  const beliefs = assembleSceneBaseline(beliefsByUser.get(userId) ?? [], transcript, selfSubjects);
  return { userId, beliefs, selfSubjects };
}

/** Pure: the `baselineRef` snapshot (0106 FLEXIBLE object). */
export function baselineRefPayload(beliefs: readonly BaselineBelief[]): SceneBaselineRef {
  return {
    beliefs: beliefs.map((b) => ({ ...b })),
    stampedAt: new Date().toISOString(),
    baselineVersion: SCENE_BASELINE_VERSION,
  };
}

/**
 * Pure: render the baseline as the prompt's "what the system currently
 * believes" block. An EMPTY baseline renders an explicit empty marker
 * rather than nothing — the model must be told it knows nothing (so it
 * cannot report deviation from an imagined model), not left to infer it
 * from a missing section.
 */
export function renderBaselineBlock(beliefs: readonly BaselineBelief[]): string {
  const head = 'Current model of the world (what the system believed BEFORE this scene):';
  if (beliefs.length === 0) {
    return `${head}\n(nothing is known about this speaker yet — nothing here can be contradicted)`;
  }
  const lines = beliefs.map(
    (b) => `- ${b.subject} | ${b.field} = ${b.value} (revision ${b.revision})`,
  );
  return `${head}\n${lines.join('\n')}`;
}

/** Find the baseline belief a delta is ABOUT, or null. */
function matchBelief(
  delta: SceneStateDelta,
  bySubject: ReadonlyMap<string, BaselineBelief[]>,
): BaselineBelief | null {
  const candidates = bySubject.get(normalizeLexical(delta.subject));
  if (candidates === undefined || candidates.length === 0) return null;
  // The belief layer's own field rule: exact name short-circuits, EXACTLY
  // one foldable candidate folds, ambiguity folds nothing (fail-closed —
  // an ambiguous match is not a measurement).
  const resolved = resolveFieldFold(
    delta.field,
    candidates.map((c) => c.field),
  );
  if (resolved.ambiguous) return null;
  return candidates.find((c) => c.field === resolved.field) ?? null;
}

/**
 * Pure, NO model call: the deterministic prediction-error scorer
 * (SCENE_PREDICTION_SCORER_VERSION). It is the paid scorer the v0
 * comment in scene-segmentation.ts was waiting for, and it costs
 * nothing.
 *
 *  - `contradiction` = share of MATCHED deltas whose `to` disagrees with
 *    the matching belief's head value (normalizeLexical compare — the
 *    belief layer's rule, no fuzzy distance). The denominator is the
 *    MATCHED deltas, not all of them: a delta with no belief behind it
 *    is evidence of neither agreement nor disagreement.
 *  - `stateChange` = durable transitions per member turn, saturating at
 *    STATE_CHANGE_SATURATION_PER_TURN.
 *  - `identity` = share of deltas about the speaker themselves.
 *
 * UNDEFINED IS NOT ZERO — the whole point. No deltas ⇒ nothing was
 * measured, so all three stay undefined. No MATCHING belief ⇒
 * `contradiction` stays undefined: an unknown baseline is not a
 * confident "no contradiction", and the caller must not turn silence
 * into a confident 0.
 */
export function scorePredictionError({
  baseline,
  stateDeltas,
  memberTurnCount,
  selfSubjects,
}: {
  baseline: readonly BaselineBelief[];
  stateDeltas: readonly SceneStateDelta[];
  memberTurnCount: number;
  selfSubjects: ReadonlySet<string>;
}): ScenePredictionError {
  if (stateDeltas.length === 0 || memberTurnCount <= 0) return {};

  const bySubject = new Map<string, BaselineBelief[]>();
  for (const belief of baseline) {
    const key = normalizeLexical(belief.subject);
    const bucket = bySubject.get(key);
    if (bucket === undefined) bySubject.set(key, [belief]);
    else bucket.push(belief);
  }

  let matched = 0;
  let disagreeing = 0;
  let selfDeltas = 0;
  for (const delta of stateDeltas) {
    if (selfSubjects.has(normalizeLexical(delta.subject))) selfDeltas += 1;
    const belief = matchBelief(delta, bySubject);
    if (belief === null) continue;
    matched += 1;
    if (normalizeLexical(delta.to) !== normalizeLexical(belief.value)) disagreeing += 1;
  }

  const error: ScenePredictionError = {
    stateChange: Math.min(
      1,
      stateDeltas.length / memberTurnCount / STATE_CHANGE_SATURATION_PER_TURN,
    ),
    identity: selfDeltas / stateDeltas.length,
  };
  if (matched > 0) error.contradiction = disagreeing / matched;
  return error;
}
