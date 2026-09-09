import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import {
  sceneBeliefFieldFoldEnabled,
  sceneBeliefLlmSynthesisEnabled,
  sceneBeliefMinScenes,
  sceneBeliefNegationDeltasEnabled,
  sceneBeliefPromotionEnabled,
  scenePackDeltaPromotionEnabled,
  sceneValueGateEnabled,
  sceneValueGateMin,
} from '../common/scene-flags';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildSupportEdgeBatches } from '../common/support-edges';
import { absorbFoldableOrphans, resolveFieldFold } from './belief-field-fold';
import {
  admitScenes,
  beliefPromoterVersion,
  buildPromotableScenesQuery,
  promoterVersionFor,
  type PromotableSceneHead,
} from './belief-scene-selection';
import { stampSupersededFrom } from './scene-baseline-ref';
import { SceneVersionService } from './scene-version';
import {
  beliefRecordString,
  commitRevision,
  corroborateBelief,
  epochMs,
  type ActiveBeliefRow,
} from './belief-revision';

// The lexical fold rule lives in belief-field-fold.ts, the scene
// selection / row shape / #387 fence / world stamping in
// belief-scene-selection.ts, the value-gate policy in
// belief-value-gate.ts and the two-producer baselineRef contract in
// scene-baseline-ref.ts (god-file split, 800-line ceiling); the first two
// are re-exported here so the historical import surface — the enricher,
// the prediction baseline, every spec — is unchanged.
export { FIELD_FOLD_GENERIC_TOKENS, fieldsFold, resolveFieldFold } from './belief-field-fold';
export {
  BELIEF_PROMOTER_VERSION,
  PACK_SCENE_WORLD_PREFIX,
  beliefPromoterVersion,
  buildPromotableScenesQuery,
  isPackSceneWorld,
  promoterVersionFor,
  sceneSingleUser,
} from './belief-scene-selection';
export type { PromotableSceneHead } from './belief-scene-selection';
export { beliefIdTail } from './belief-revision';

/**
 * Belief promotion (Belief-A, SCENES_BELIEF_PROMOTION — default off):
 * folds ENRICHED scenes of the CURRENT effective segmenter version
 * (SceneVersionService.resolve, the Drift-3 once-per-run contract) into
 * the shadow semantic_belief substrate (migration 0120) — the
 * MemoryEpisode[] -> SemanticBelief distillation. Triggered ONLY from
 * the scenes admin surface (POST /v1/admin/maintenance/scenes/beliefs).
 *
 * FOLD. Each enriched scene's stateDeltas ({subject, field, from, to} —
 * enrichment-owned, 0118) are grouped by (userId, subject, field) —
 * free-text keys, deliberately unresolved (the 0120 header's
 * SemanticBelief/Claim separation). Within a group, contributions are
 * ordered by scene time (occurredTo, then scene id — deterministic);
 * the LATEST value wins and earlier values are its history, exactly like
 * sequential state transitions. gist/memoryValue fold in as provenance
 * and confidence signal (enrichedMemoryValue.explicitness), never as
 * keys.
 *
 * NEGATION DELTAS (#135 seam 1, SCENES_BELIEF_NEGATION_DELTAS — default
 * off): an empty-`to` delta with a NON-empty `from` is a state REMOVAL
 * (sold/quit/ended — the owns:true→false transition), historically
 * dropped by the no-landing-value guard, so the belief plane kept
 * asserting the removed state forever. With the flag on, such a delta
 * contributes the canonical sentinel value BELIEF_NEGATION_VALUE
 * ('none') with priorValue = the delta's `from`; the ordinary supersede
 * chain below then revises the belief naturally ('none' differs from
 * the current value). Both-ends-empty deltas stay dropped, flag on or
 * off — nothing to negate.
 *
 * FIELD FOLD (#135 seam 2, SCENES_BELIEF_FIELD_FOLD — default off): the
 * enricher re-coins free-text field names per scene ('car' vs 'car
 * ownership'), so exact-string grouping created PARALLEL beliefs
 * instead of revisions. With the flag on, an incoming field name folds
 * onto an existing one — existing ACTIVE beliefs of the same (userId,
 * subject) plus fields already admitted earlier in the same batch —
 * under the deterministic lexical fieldsFold rule (token-set subset
 * whose extra tokens are all generic modifiers; NO embeddings, NO LLM)
 * BEFORE the group key is built, so negation + fold compose. The
 * EXISTING name wins (stability); more than one match folds NOTHING and
 * warns loudly (the skip-loudly, never-flip-flop doctrine).
 *
 * ORPHAN ABSORB (#135 seam 2 follow-up, same flag): the fold only
 * routes INCOMING names — it cannot retire a belief already stored
 * under a foldable VARIANT of the group's canonical field (an earlier
 * batch's leftover), which keeps serving its stale value next to the
 * canonical belief (the s08 field-drift eval: "Lisbon" kept answering
 * after "Porto" won). After every canonical upsert such orphans are
 * stamped superseded — the full doctrine (mark-never-DELETE rationale,
 * priorValue backfill, same-run fence, ambiguity skip, idempotence)
 * lives on absorbFoldableOrphans in belief-field-fold.ts.
 *
 * PACK DELTAS (SCENES_PACK_DELTA_PROMOTION — default off): the pass
 * additionally admits scenes of the PACK-PROJECTION worlds
 * (`segmenterVersion` = `pack:<packId>+<fp>`, written by
 * SceneCandidateWriterService when a document's external indexer stages
 * 0110 scene/state_delta candidates). Two fences kept those scenes out
 * of the belief plane entirely, so `PACK_MEMORY_PROJECTIONS_ENABLED`
 * (ON in prod) was a write with no reader:
 *   1. their deltas carried `stateModelId`, never the `field` the fold
 *      keys on — fixed at PROJECTION time (packDeltaField writes BOTH,
 *      `<packId>__<stateModel.field ?? stateModelId>`);
 *   2. the version fence pinned the composer's effective world — widened
 *      here (buildPromotableScenesQuery), behind this flag.
 * The pack leg also drops the `enrichmentVersion IS NOT NONE`
 * requirement, which a pack scene will never satisfy: its deltas come
 * from the pack indexer's reading, not from the LLM enricher (its
 * explicitness therefore falls back to DEFAULT_EXPLICITNESS).
 *
 * The FENCES that must survive the widening, and do:
 *  - PER-USER SCOPE: unchanged. A projected scene inherits the
 *    document's 0128 stamp (userId + 0093 scope + 0117 userIds), so
 *    sceneSingleUser admits it only for that one user — and a
 *    TENANT-GLOBAL document's scenes (no userIds) are skipped
 *    fail-closed like any other, never promoted into someone's beliefs.
 *  - CROSS-PACK COLLISION: the field is pack-NAMESPACED, so two packs
 *    whose stateModels resolve to the same local attribute stay in
 *    separate (userId, subject, field) groups. They are kept distinct,
 *    deliberately, rather than merged — the predicate/tool namespace
 *    rule (`<packId>__<name>`) applied to the belief plane.
 *  - PACK PROVENANCE: a belief folded wholly out of one pack world is
 *    stamped promoterVersion `belief-promotion-v1|pack:<packId>+<fp>`
 *    (promoterVersionFor) — an existing column, no migration.
 *
 * MEMORY-VALUE GATE (SCENES_VALUE_GATE_ENABLED — default off): the first
 * real consumer of the 0106 value vector. Until now this pass read
 * exactly ONE of its six dimensions (`explicitness`, as the confidence
 * signal above) and the other five were a write nothing read — including
 * the two the measured `scene-scorer-v1` fills under
 * SCENES_PREDICTION_BASELINE. With the flag on, a scene must clear a
 * noise floor (SCENES_VALUE_GATE_MIN, default 0.05) on at least ONE of
 * novelty / contradiction / stateChange before its deltas may change the
 * belief plane. The policy is asymmetric on purpose — "promote unless
 * demonstrably noise" — so a scene is refused ONLY when all three
 * dimensions are PRESENT and all three are below the floor; an UNDEFINED
 * dimension is an unknown, never a confident zero, and short-circuits to
 * promote. An unscored world (pack scenes, legacy rows, enrichment off)
 * therefore behaves exactly as with the gate off. Refusals are counted
 * (`skippedLowValue`, in the run summary and the API response) and logged
 * per scene with the dimensions that produced them. The full doctrine
 * lives on `sceneValueVerdict` in belief-value-gate.ts. Off ⇒ the value
 * dimensions are not even projected — byte-identical selection and fold.
 *
 * CONFLICT GUARD (built-in, no flag): a group whose latest timestamp is
 * shared by two DIFFERENT values has no deterministic winner — the whole
 * (subject, field) group is SKIPPED LOUDLY with a warn. Same for a
 * differing candidate whose own latest evidence is not past the active
 * belief's WATERMARK (stale re-promotion — skipped loudly, never
 * flip-flopped).
 *
 * TWO CLOCKS (audit 2026-09-06 F6). A revision carries `validFrom` —
 * when the state BEGAN, the opener of the trailing same-value run of
 * its evidence — and `latestEvidenceAt` (0137) — the WATERMARK, the
 * latest scene it has processed. A confirmation advances the watermark
 * and leaves the beginning alone; a differing value is judged against
 * the watermark, so evidence older than what the belief already saw
 * cannot revise it in ANY arrival order (A on Jan 1, A again on Mar 1,
 * then B dated Feb 1 arriving late stays a skip). A TARGETED run
 * (conversationId) therefore folds the affected users' WHOLE promotable
 * chain, not the one conversation, and promotes only the keys that
 * conversation touched — a late scene lands at its place in the chain.
 * The verdict is a function of the evidence, not of the order the runs
 * saw it: every permutation converges to the same active row
 * (belief-revision-chain.e2e-spec).
 *
 * REVISIONS: supersede chain in code, NEVER in-place for values. A new
 * value creates revision N+1 and stamps the old row status='superseded'
 * + validUntil + supersededBy — the two in ONE compare-and-set
 * transaction (commitRevision), so a head that moved under the run, or
 * a revision slot another run filled with a different value, aborts
 * cleanly instead of leaving two active heads. In-place UPDATE is
 * allowed ONLY for the corroboration counters (sourceSceneIds /
 * conversationIds / corroborationCount / conversationCount / updatedAt),
 * the watermark, and the two chain-derived corrections that change no
 * value: validFrom (when the same value began) and a missing priorValue
 * (what it displaced). fn::resolve_fact reuse was REJECTED
 * (claim-specific — 0120 header).
 *
 * PROVENANCE: sourceSceneIds is the inline canonical trail (survives
 * flag-off); when PROVENANCE_SUPPORT_EDGES is on, the pass additionally
 * mirrors it into memory_support (supported_by belief->scene) and marks
 * revisions (contradicted_by old->new, derived_from new->old), writer
 * 'belief_promotion' — INSERT RELATION IGNORE, replay-idempotent.
 *
 * SCENE CONTRACTS (0106, finally fulfilled): consumed scenes get
 * consolidatedInto ∪= [belief] (idempotent array::union; column widened
 * to generic records in 0120) and — on a revision ONLY — the
 * `baselineRef.supersededFrom` backpointer {belief, revision, value,
 * stampedAt}: the belief revision the delta was applied against.
 * Revision 1 has no baseline (the section is never written).
 *
 * `baselineRef` IS NAMESPACED (two producers, one FLEXIBLE column). The
 * enrichment pass stamps an EXPECTATION snapshot into the same column
 * under SCENES_PREDICTION_BASELINE, and both writers used to own the
 * whole object — so a promotion revision destroyed the pre-scene world
 * model that nothing else records. This pass now writes the two sections
 * side by side, `{expectation, supersededFrom}`, preserving whatever
 * snapshot it finds in ANY of the tolerated shapes (namespaced, legacy
 * expectation, legacy backpointer, hybrid). No migration: the column is
 * FLEXIBLE and the reading rule handles every shape. The whole contract
 * — reader, merge and the primary-key read-then-write — lives in
 * scene-baseline-ref.ts.
 *
 * #387 USER FENCE (fail-closed): a belief inherits the SINGLE-user
 * scope of its scenes. A scene whose userIds (0117) is missing (legacy,
 * pre-0117), empty (tenant-global), or has more than one member — or
 * disagrees with the folded userId stamp — is SKIPPED LOUDLY.
 *
 * IDEMPOTENT: deterministic record ids over (userId|subject|field|
 * revision) + INSERT IGNORE + array::union stamps ⇒ a re-run over the
 * same scene world converges without duplicates; a same-value re-fold
 * is a pure corroboration no-op.
 *
 * OFF = ZERO QUERIES: with SCENES_BELIEF_PROMOTION off the controller
 * 404s AND this service returns before touching the version resolver or
 * the database (pinned by unit test) — byte-identical prod.
 *
 * TESTABILITY: `openai` is the enricher's stub-injectable idiom — a
 * plain private field holding only the chat.completions.create surface;
 * tests swap it for a scripted stub, NO paid call ever happens in CI.
 * The deterministic template fold works with no client at all.
 */

/** Belts against runaway payloads (the enricher's cap discipline). */
const STATEMENT_MAX_CHARS = 500;
const SYNTHESIS_VISIBLE_CAP = 400;

/** Confidence fold constants: explicitness mean + corroboration bonus. */
const DEFAULT_EXPLICITNESS = 0.5;
const CORROBORATION_BONUS = 0.05;
const CONFIDENCE_CAP = 0.95;
const CONFIDENCE_FLOOR = 0.05;

export const BELIEF_SYNTHESIS_SYSTEM = `You phrase ONE remembered belief — a (subject, attribute, value) state a user's conversations established — as a single natural sentence. Output strictly the JSON schema: "statement": one concise declarative sentence stating the belief content itself (never meta-language like "the user said"). Include the previous value only when one is given.`;

/**
 * Canonical negation sentinel (#135 seam 1): the folded value of an
 * admitted state-REMOVAL delta (empty `to`, non-empty `from`). A plain
 * string on purpose — it flows through the existing supersede chain,
 * template and lane render unchanged ('subject — field: none (was:
 * prior)').
 */
export const BELIEF_NEGATION_VALUE = 'none';

/**
 * SCENES_BELIEF_NEGATION_DELTAS synthesis-prompt clause — appended to
 * BELIEF_SYNTHESIS_SYSTEM only when the flag is on AND the write
 * involves the sentinel (the generator-prompt split-constant idiom,
 * #412/#413/#415: flag off ⇒ byte-identical prompt).
 */
export const BELIEF_SYNTHESIS_NEGATION_CLAUSE = ` A value of "${BELIEF_NEGATION_VALUE}" means the subject NO LONGER has the attribute — phrase it as a natural negation (e.g. "no longer has a car"), never as possessing something called "${BELIEF_NEGATION_VALUE}".`;

/** One delta occurrence, normalized for the fold. */
export interface BeliefContribution {
  sceneId: string;
  conversationId: string;
  /** Scene occurredTo as epoch ms — the fold's ordering axis. */
  occurredAt: number;
  value: string;
  priorValue: string;
  explicitness: number;
  /**
   * The contributing scene's world (segmenterVersion). '' unless
   * SCENES_PACK_DELTA_PROMOTION selected the column — which is exactly
   * why the flag-off stamps are unchanged.
   */
  world: string;
}

/** One promotable (userId, subject, field) verdict out of the fold. */
export interface FoldedBelief {
  userId: string;
  subject: string;
  field: string;
  value: string;
  /**
   * The value the current state displaced: the chain's previous distinct
   * value when the winning run does not open the chain, else the
   * run-opening delta's own `from` ('' when unknown).
   */
  priorValue: string;
  /**
   * The chain's previous distinct value alone ('' when the winning run
   * opens the chain) — what a corroboration may backfill onto a head that
   * records no priorValue. Unlike priorValue it never falls back to a
   * delta's self-reported `from`.
   */
  displacedValue: string;
  /** When the chain last held displacedValue — undefined with it. */
  displacedAt?: Date;
  /**
   * When the current state BEGAN — the earliest contribution of the
   * trailing same-value run, never the latest confirmation (audit
   * 2026-09-06 F6). A re-confirmation on a later day leaves it where it
   * is; an interlude of another value moves it to the run that followed.
   */
  validFrom: Date;
  /**
   * The latest evidence behind the winning value — the run's last
   * contribution — i.e. the revision WATERMARK. A differing candidate
   * whose own evidenceAt is not past the active belief's watermark is
   * stale: the belief has already processed later evidence.
   */
  evidenceAt: Date;
  /**
   * Every contribution time of the trailing run, ascending — validFrom
   * is the first, evidenceAt the last. A revision that follows a head
   * whose watermark falls inside the run begins at the first of these
   * past that watermark.
   */
  runEvidenceAt: Date[];
  /** Scenes contributing the WINNING value (distinct, emission order). */
  sceneIds: string[];
  /**
   * EVERY scene that contributed to this key, winning value or not
   * (distinct). A targeted run uses it to tell which keys the folded
   * conversation actually touched.
   */
  allSceneIds: string[];
  /** Distinct conversations behind those scenes — the floor unit. */
  conversationIds: string[];
  confidence: number;
  /**
   * Distinct scene worlds behind the WINNING value (sorted). Empty
   * unless SCENES_PACK_DELTA_PROMOTION selected segmenterVersion; a
   * single `pack:` world becomes the belief's promoterVersion stamp
   * (promoterVersionFor) — the pack provenance carried onto the row
   * without a new column.
   */
  worlds: string[];
}

export interface BeliefFold {
  folded: FoldedBelief[];
  /** Groups the conflict guard refused (ambiguous latest value). */
  conflicts: Array<{
    userId: string;
    subject: string;
    field: string;
    values: string[];
    /** Every contributing scene — the targeted-run touch test. */
    allSceneIds: string[];
  }>;
  /** SCENES_BELIEF_FIELD_FOLD: incoming names folded onto existing ones. */
  fieldFolds: Array<{ userId: string; subject: string; from: string; to: string }>;
  /** Field-fold ambiguity guard: >1 existing candidates — NOT folded. */
  fieldFoldAmbiguities: Array<{
    userId: string;
    subject: string;
    field: string;
    candidates: string[];
  }>;
}

/** Fold behavior knobs, resolved ONCE per run (the Drift-3 contract). */
export interface BeliefFoldOptions {
  /** SCENES_BELIEF_NEGATION_DELTAS: admit empty-`to` removal deltas. */
  negationDeltas?: boolean;
  /**
   * SCENES_BELIEF_FIELD_FOLD: existing ACTIVE belief field names per
   * (userId, subject) — key `${userId}\x00${subject}`. Undefined (flag
   * off) ⇒ exact-string grouping, byte-identical to the historical fold.
   */
  existingFields?: ReadonlyMap<string, readonly string[]>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Pure: a delta's landing value, or null when it holds nothing
 * promotable. The historical rule drops every empty-`to` delta; with
 * negationDeltas on (#135 seam 1) an empty-`to` / non-empty-`from`
 * delta — a state REMOVAL — lands as the canonical sentinel instead.
 * Both ends empty stays dropped, flag on or off — nothing to negate.
 */
function admitDeltaValue(
  d: Record<string, unknown>,
  negationDeltas: boolean,
): { value: string; priorValue: string } | null {
  const priorValue = str(d.from);
  const value = str(d.to);
  if (value !== '') return { value, priorValue };
  if (negationDeltas && priorValue !== '') return { value: BELIEF_NEGATION_VALUE, priorValue };
  return null;
}

/** Mutable fold-state threaded through the per-delta field resolution. */
interface FieldFoldState {
  /** Fields already admitted this batch, per (userId, subject) — the
   *  intra-batch fold candidates (first-seen order, deterministic for a
   *  given scene order). */
  batchFields: Map<string, string[]>;
  fieldFolds: Map<string, BeliefFold['fieldFolds'][number]>;
  fieldFoldAmbiguities: Map<string, BeliefFold['fieldFoldAmbiguities'][number]>;
}

/**
 * #135 seam 2: fold one delta's field BEFORE the group key is built, so
 * negation + fold compose. Candidates: existing ACTIVE belief fields of
 * this (userId, subject) ∪ fields already admitted earlier in this
 * batch (so a two-scene create+negate batch converges to ONE group).
 * Returns the group field name and records folds/ambiguities in state.
 */
function foldDeltaField(
  { userId, subject, field }: { userId: string; subject: string; field: string },
  existingFields: ReadonlyMap<string, readonly string[]>,
  state: FieldFoldState,
): string {
  const subjectKey = `${userId}\x00${subject}`;
  const known = [
    ...(existingFields.get(subjectKey) ?? []),
    ...(state.batchFields.get(subjectKey) ?? []),
  ];
  const resolved = resolveFieldFold(field, known);
  let groupField = field;
  if (resolved.ambiguous) {
    state.fieldFoldAmbiguities.set(`${subjectKey}\x00${field}`, {
      userId,
      subject,
      field,
      candidates: resolved.candidates,
    });
  } else if (resolved.folded) {
    state.fieldFolds.set(`${subjectKey}\x00${field}`, {
      userId,
      subject,
      from: field,
      to: resolved.field,
    });
    groupField = resolved.field;
  }
  const seen = state.batchFields.get(subjectKey);
  if (seen === undefined) state.batchFields.set(subjectKey, [groupField]);
  else if (!seen.includes(groupField)) seen.push(groupField);
  return groupField;
}

type BeliefGroups = Map<
  string,
  { userId: string; subject: string; field: string; contributions: BeliefContribution[] }
>;

/** Scene-head fields the fold consumes, parsed defensively. */
interface SceneFoldContext {
  sceneId: string;
  conversationId: string;
  occurredAt: number;
  explicitness: number;
  /** segmenterVersion, '' when the column was not selected (flag off). */
  world: string;
}

/** Pure: parse one scene's head for the fold; null = unusable (unordered). */
function sceneFoldContext(scene: PromotableSceneHead): SceneFoldContext | null {
  const sceneId = String(scene.id);
  const conversationId = Array.isArray(scene.conversationIds) ? str(scene.conversationIds[0]) : '';
  // WS-driver datetimes arrive as Date instances; e2e/unit fixtures may
  // hand ISO strings — accept both, never String(Date) (query_arc lesson).
  const occurredAt =
    scene.occurredTo instanceof Date
      ? scene.occurredTo.getTime()
      : new Date(String(scene.occurredTo ?? '')).getTime();
  if (!Number.isFinite(occurredAt)) return null;
  const explicitnessRaw = scene.explicitness;
  const explicitness =
    typeof explicitnessRaw === 'number' && Number.isFinite(explicitnessRaw)
      ? Math.min(1, Math.max(0, explicitnessRaw))
      : DEFAULT_EXPLICITNESS;
  return { sceneId, conversationId, occurredAt, explicitness, world: str(scene.segmenterVersion) };
}

/**
 * Pure (mutates groups/foldState): admit one scene's stateDeltas into
 * their (userId, subject, field) groups — subject/field presence guard,
 * value admission (admitDeltaValue, #135 seam 1), field folding
 * (foldDeltaField, #135 seam 2) BEFORE the group key is built.
 */
function collectSceneDeltas({
  scene,
  userId,
  head,
  opts,
  foldState,
  groups,
}: {
  scene: PromotableSceneHead;
  userId: string;
  head: SceneFoldContext;
  opts: BeliefFoldOptions;
  foldState: FieldFoldState;
  groups: BeliefGroups;
}): void {
  for (const delta of Array.isArray(scene.stateDeltas) ? scene.stateDeltas : []) {
    if (typeof delta !== 'object' || delta === null) continue;
    const d = delta as Record<string, unknown>;
    const subject = str(d.subject);
    const rawField = str(d.field);
    if (subject === '' || rawField === '') continue;
    const admitted = admitDeltaValue(d, opts.negationDeltas === true);
    if (admitted === null) continue;
    const field =
      opts.existingFields !== undefined
        ? foldDeltaField({ userId, subject, field: rawField }, opts.existingFields, foldState)
        : rawField;
    const key = `${userId}\x00${subject}\x00${field}`;
    let group = groups.get(key);
    if (!group) {
      group = { userId, subject, field, contributions: [] };
      groups.set(key, group);
    }
    group.contributions.push({
      sceneId: head.sceneId,
      conversationId: head.conversationId,
      occurredAt: head.occurredAt,
      value: admitted.value,
      priorValue: admitted.priorValue,
      explicitness: head.explicitness,
      world: head.world,
    });
  }
}

/**
 * Pure: one (userId, subject, field) group's verdict — the latest value
 * wins (contributions ordered by occurredAt then scene id, so the fold
 * is deterministic); a DIFFERENT value at the winning timestamp means
 * the batch has no deterministic latest state and the whole group is a
 * conflict (the built-in guard) — never half-promoted.
 */
function foldGroupVerdict(group: {
  userId: string;
  subject: string;
  field: string;
  contributions: BeliefContribution[];
}): { conflict: BeliefFold['conflicts'][number] } | { folded: FoldedBelief } {
  const ordered = [...group.contributions].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.sceneId.localeCompare(b.sceneId),
  );
  const winner = ordered[ordered.length - 1]!;
  const ambiguous = ordered.some(
    (c) => c.occurredAt === winner.occurredAt && c.value !== winner.value,
  );
  const allSceneIds = [...new Set(ordered.map((c) => c.sceneId))];
  if (ambiguous) {
    return {
      conflict: {
        userId: group.userId,
        subject: group.subject,
        field: group.field,
        values: [...new Set(ordered.map((c) => c.value))].sort(),
        allSceneIds,
      },
    };
  }
  const corroborating = ordered.filter((c) => c.value === winner.value);
  const sceneIds = [...new Set(corroborating.map((c) => c.sceneId))];
  // The trailing same-value run: walk back from the winner while the
  // value holds. Its opener is when the current state BEGAN; the winner
  // is the latest evidence for it (the watermark). Confirmations that sit
  // BEFORE an interlude of another value still corroborate — they are
  // evidence for the value — but they do not pull the beginning back past
  // the interlude: the state was interrupted and began again.
  let runStart = ordered.length - 1;
  while (runStart > 0 && ordered[runStart - 1]!.value === winner.value) runStart -= 1;
  const opener = ordered[runStart]!;
  const displaced = runStart > 0 ? ordered[runStart - 1]!.value : '';
  const priorValue = displaced !== '' ? displaced : opener.priorValue;
  const conversationIds = [
    ...new Set(corroborating.map((c) => c.conversationId).filter((c) => c !== '')),
  ];
  const meanExplicitness =
    corroborating.reduce((sum, c) => sum + c.explicitness, 0) / corroborating.length;
  const confidence = Math.min(
    CONFIDENCE_CAP,
    Math.max(
      CONFIDENCE_FLOOR,
      meanExplicitness + CORROBORATION_BONUS * Math.max(0, conversationIds.length - 1),
    ),
  );
  return {
    folded: {
      userId: group.userId,
      subject: group.subject,
      field: group.field,
      value: winner.value,
      priorValue,
      displacedValue: displaced,
      ...(runStart > 0 ? { displacedAt: new Date(ordered[runStart - 1]!.occurredAt) } : {}),
      validFrom: new Date(opener.occurredAt),
      evidenceAt: new Date(winner.occurredAt),
      runEvidenceAt: ordered.slice(runStart).map((c) => new Date(c.occurredAt)),
      sceneIds,
      allSceneIds,
      conversationIds,
      confidence: Math.round(confidence * 10000) / 10000,
      // Distinct worlds behind the winning value (sorted = deterministic).
      // Empty with the flag off — the column is not even selected.
      worlds: [...new Set(corroborating.map((c) => c.world).filter((w) => w !== ''))].sort(),
    },
  };
}

/**
 * Pure: group eligible scenes' stateDeltas by (userId, subject, field)
 * and fold each group to one verdict via foldGroupVerdict (latest value
 * wins; deterministic ordering). Groups whose latest timestamp carries
 * two different values are returned as conflicts (the built-in guard) —
 * never half-promoted.
 *
 * With opts.negationDeltas (#135 seam 1) an empty-`to` / non-empty-
 * `from` delta contributes BELIEF_NEGATION_VALUE instead of being
 * dropped (admitDeltaValue); with opts.existingFields (#135 seam 2)
 * each admitted delta's field runs through foldDeltaField BEFORE the
 * group key is built. No opts ⇒ byte-identical to the historical fold.
 */
export function foldBeliefGroups(
  scenes: ReadonlyArray<{ scene: PromotableSceneHead; userId: string }>,
  opts: BeliefFoldOptions = {},
): BeliefFold {
  const groups: BeliefGroups = new Map();
  const foldState: FieldFoldState = {
    batchFields: new Map(),
    fieldFolds: new Map(),
    fieldFoldAmbiguities: new Map(),
  };
  for (const { scene, userId } of scenes) {
    const head = sceneFoldContext(scene);
    if (head === null) continue; // unordered scene: unusable
    collectSceneDeltas({ scene, userId, head, opts, foldState, groups });
  }

  const fold: BeliefFold = {
    folded: [],
    conflicts: [],
    fieldFolds: [...foldState.fieldFolds.values()],
    fieldFoldAmbiguities: [...foldState.fieldFoldAmbiguities.values()],
  };
  for (const group of groups.values()) {
    const verdict = foldGroupVerdict(group);
    if ('conflict' in verdict) fold.conflicts.push(verdict.conflict);
    else fold.folded.push(verdict.folded);
  }
  // Deterministic emission order (stable logs, stable tests).
  fold.folded.sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      a.subject.localeCompare(b.subject) ||
      a.field.localeCompare(b.field),
  );
  return fold;
}

/** Pure: the deterministic statement template (works with no LLM). */
export function renderBeliefStatement(f: {
  subject: string;
  field: string;
  value: string;
  priorValue: string;
}): string {
  const base = `${f.subject} — ${f.field}: ${f.value}`;
  const withPrior =
    f.priorValue !== '' && f.priorValue !== f.value ? `${base} (was: ${f.priorValue})` : base;
  return withPrior.slice(0, STATEMENT_MAX_CHARS);
}

export interface BeliefPromotionResult {
  /** Enriched scenes of the current version seen by the pass. */
  scenes: number;
  /** Scenes that reached the fold: past the #387 fence AND the value gate. */
  eligibleScenes: number;
  skippedMixedUser: number;
  /**
   * Scenes the memory-value gate refused as demonstrably noise (0 unless
   * SCENES_VALUE_GATE_ENABLED) — the gate's audit counter.
   */
  skippedLowValue: number;
  /** (subject, field) groups the conflict guard refused. */
  skippedConflict: number;
  /** Field names folded onto an existing one (SCENES_BELIEF_FIELD_FOLD). */
  fieldFolds: number;
  /** Field names left UNfolded because >1 existing field matched. */
  fieldFoldAmbiguous: number;
  /** Foldable-variant orphan beliefs superseded into the canonical one. */
  fieldOrphansAbsorbed: number;
  /** Orphan sweeps skipped: >1 distinct foldable field (never merged). */
  fieldOrphanAmbiguous: number;
  /** Groups below the SCENES_BELIEF_MIN_SCENES conversation floor. */
  skippedFloor: number;
  /** Groups whose winner was not newer than the active belief (stale). */
  skippedStale: number;
  beliefsCreated: number;
  beliefsCorroborated: number;
  beliefsRevised: number;
  /**
   * Active beliefs whose validFrom / priorValue were corrected from the
   * full evidence chain without a value change (a late-arriving scene
   * showed the state began at a different time, or what it displaced).
   */
  beliefsRealigned: number;
  /**
   * Revisions this run lost to a concurrent writer of the same key: the
   * compare-and-set transaction found the head already superseded, or
   * the revision slot already holding another value. Nothing was
   * written; the next run recomputes the key from its evidence.
   */
  skippedContended: number;
  /** memory_support rows written (0 unless PROVENANCE_SUPPORT_EDGES). */
  supportEdges: number;
}

export interface BeliefDb {
  query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
}

/** The one client surface the synthesis uses (mock-swappable in tests). */
type ChatCompletionsClient = Pick<OpenAI, 'chat'>;

@Injectable()
export class BeliefPromotionService {
  private readonly logger = new Logger(BeliefPromotionService.name);
  /**
   * Nullable by contract (createOpenAiClient): no OPENAI_API_KEY ⇒ the
   * optional synthesis degrades to the template. Tests replace this
   * field with a scripted stub (mockBeliefSynthesisOpenAi) — the same
   * seam as SceneEnricherService.openai.
   */
  private readonly openai: ChatCompletionsClient | null;
  private readonly model: string;

  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly versions: SceneVersionService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = configService.get<string>(
      'SCENES_BELIEF_MODEL',
      configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
  }

  /**
   * Promote every enriched scene of the CURRENT segmenter version
   * (optionally one conversation's). Per-group problems degrade to a
   * loud skip — the pass never throws for one bad group.
   */
  async run(
    companyId: string,
    opts: { conversationId?: string } = {},
  ): Promise<BeliefPromotionResult> {
    const result: BeliefPromotionResult = {
      scenes: 0,
      eligibleScenes: 0,
      skippedMixedUser: 0,
      skippedLowValue: 0,
      skippedConflict: 0,
      fieldFolds: 0,
      fieldFoldAmbiguous: 0,
      fieldOrphansAbsorbed: 0,
      fieldOrphanAmbiguous: 0,
      skippedFloor: 0,
      skippedStale: 0,
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
      beliefsRealigned: 0,
      skippedContended: 0,
      supportEdges: 0,
    };
    // Defense in depth: the controller already 404s with the flag off; a
    // programmatic caller must not write belief rows past a disabled
    // flag. Off = ZERO queries (returns before the version resolver and
    // before any db handle) — pinned by unit test.
    if (!sceneBeliefPromotionEnabled()) return result;
    // Effective world + knobs resolved ONCE per run (the Drift-3
    // contract): a mid-run env flip can never mix worlds or floors.
    const { version } = this.versions.resolve();
    const promoterVersion = beliefPromoterVersion(version);
    const floor = sceneBeliefMinScenes();
    const edgesOn = supportEdgesEnabled();
    const negationDeltas = sceneBeliefNegationDeltasEnabled();
    const fieldFoldOn = sceneBeliefFieldFoldEnabled();
    const packDeltas = scenePackDeltaPromotionEnabled();
    const valueGate = sceneValueGateEnabled();
    const valueGateMin = valueGate ? sceneValueGateMin() : 0;
    await this.surreal.withCompany(companyId, async (db) => {
      const selection = buildPromotableScenesQuery({
        version,
        ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
        packDeltas,
        valueGate,
      });
      const [scenes] = await db.query<[PromotableSceneHead[]]>(selection.sql, selection.params);
      const gate = { valueGate, valueGateMin };
      const eligible = admitScenes({
        scenes: scenes ?? [],
        gate,
        count: result,
        logger: this.logger,
      });

      // FULL-CHAIN RECOMPUTE (audit 2026-09-06 F6). A targeted run selects
      // ONE conversation's scenes, but a belief is the verdict of ALL the
      // evidence for its key, in time order — a late-arriving scene must
      // land at its place in the chain, not be judged against the head
      // alone (which is how a stale value dated between two confirmations
      // used to displace the confirmed one). So the scenes the run folds
      // are the affected users' whole promotable world; the batch only
      // decides WHICH keys this run is about (the ones its scenes touch)
      // and what the run summary counts. A full run already reads the
      // whole world — nothing to add there.
      const batchSceneIds = new Set(eligible.map((e) => String(e.scene.id)));
      let foldInput = eligible;
      if (opts.conversationId !== undefined && eligible.length > 0) {
        const chainSelection = buildPromotableScenesQuery({
          version,
          packDeltas,
          valueGate,
          userIds: [...new Set(eligible.map((e) => e.userId))],
        });
        const [chainScenes] = await db.query<[PromotableSceneHead[]]>(
          chainSelection.sql,
          chainSelection.params,
        );
        foldInput = admitScenes({
          scenes: chainScenes ?? [],
          gate,
          count: null,
          logger: this.logger,
        });
        // The batch's scenes are part of the chain by construction (same
        // users, no conversation filter); a chain read that somehow
        // lacks one falls back to folding the batch alone rather than
        // silently dropping the run's own evidence.
        if (
          !eligible.every((e) => foldInput.some((c) => String(c.scene.id) === String(e.scene.id)))
        ) {
          this.logger.warn(
            `belief promotion: chain read for ${opts.conversationId} missed batch scenes — ` +
              `folding the batch alone`,
          );
          foldInput = eligible;
        }
      }

      // #135 seam 2: fold candidates are the existing ACTIVE belief
      // field names per (userId, subject) — one plain SELECT (safe on
      // the 3.2.4 planner; the DELETE-WHERE trap does not apply to
      // reads). Flag off ⇒ zero extra queries.
      let existingFields: Map<string, string[]> | undefined;
      if (fieldFoldOn && foldInput.length > 0) {
        const userIds = [...new Set(foldInput.map((e) => e.userId))];
        const [rows] = await db.query<
          [Array<{ userId: unknown; subject: unknown; field: unknown }>]
        >(
          `SELECT userId, subject, field FROM semantic_belief
            WHERE status = 'active' AND userId INSIDE $userIds`,
          { userIds },
        );
        existingFields = new Map();
        for (const row of rows ?? []) {
          const u = str(row.userId);
          const s = str(row.subject);
          const fieldName = str(row.field);
          if (u === '' || s === '' || fieldName === '') continue;
          const key = `${u}\x00${s}`;
          const list = existingFields.get(key);
          if (list === undefined) existingFields.set(key, [fieldName]);
          else if (!list.includes(fieldName)) list.push(fieldName);
        }
      }

      const chainFold = foldBeliefGroups(foldInput, {
        negationDeltas,
        ...(existingFields !== undefined ? { existingFields } : {}),
      });
      // A targeted run promotes only the keys its own scenes touch — the
      // rest of the users' chain was context for the fold, not this run's
      // business (its verdicts are unchanged and would only re-stamp).
      const touched = (g: { allSceneIds: string[] }) =>
        foldInput === eligible || g.allSceneIds.some((s) => batchSceneIds.has(s));
      const folded = chainFold.folded.filter(touched);
      const conflicts = chainFold.conflicts.filter(touched);
      const { fieldFolds, fieldFoldAmbiguities } = chainFold;
      result.skippedConflict = conflicts.length;
      result.fieldFolds = fieldFolds.length;
      result.fieldFoldAmbiguous = fieldFoldAmbiguities.length;
      for (const c of conflicts) {
        this.logger.warn(
          `belief promotion conflict guard: (${c.subject}, ${c.field}) for user ${c.userId} ` +
            `has irreconcilable in-batch values [${c.values.join(' | ')}] — group skipped`,
        );
      }
      for (const ff of fieldFolds) {
        this.logger.log(
          `belief promotion field fold: '${ff.from}' folded onto existing field '${ff.to}' ` +
            `for subject ${ff.subject} (user ${ff.userId}) — SCENES_BELIEF_FIELD_FOLD`,
        );
      }
      for (const amb of fieldFoldAmbiguities) {
        this.logger.warn(
          `belief promotion field-fold ambiguity: '${amb.field}' for subject ${amb.subject} ` +
            `(user ${amb.userId}) matches ${amb.candidates.length} existing fields ` +
            `[${amb.candidates.join(' | ')}] — NOT folded (skip loudly, never flip-flop)`,
        );
      }

      // ORPHAN ABSORB fence: every (userId, subject, field) the CURRENT
      // run still folds to — including conflict-skipped groups — is a
      // live attribute name; the sweep must never eat a parallel group
      // the fold deliberately kept (upsert order would otherwise decide
      // which sibling survives).
      const runGroupKeys = new Set<string>(
        [...folded, ...conflicts].map((g) => `${g.userId}\x00${g.subject}\x00${g.field}`),
      );

      for (const belief of folded) {
        if (floor > 0 && belief.conversationIds.length < floor) {
          result.skippedFloor += 1;
          this.logger.debug(
            `belief promotion floor: (${belief.subject}, ${belief.field}) has ` +
              `${belief.conversationIds.length} conversation(s) < floor ${floor} — not promoted`,
          );
          continue;
        }
        await this.upsertBelief({ db, belief, promoterVersion, edgesOn, result });
        if (fieldFoldOn) {
          await absorbFoldableOrphans({ db, belief, runGroupKeys, result, logger: this.logger });
        }
      }
    });
    this.logger.log(
      `belief promotion pass: ${result.beliefsCreated} created, ` +
        `${result.beliefsCorroborated} corroborated, ${result.beliefsRevised} revised ` +
        `over ${result.eligibleScenes}/${result.scenes} scene(s) ` +
        `(mixedUser=${result.skippedMixedUser} lowValue=${result.skippedLowValue} ` +
        `conflict=${result.skippedConflict} ` +
        `fieldFolds=${result.fieldFolds} foldAmbiguous=${result.fieldFoldAmbiguous} ` +
        `orphansAbsorbed=${result.fieldOrphansAbsorbed} ` +
        `orphanAmbiguous=${result.fieldOrphanAmbiguous} ` +
        `floor=${result.skippedFloor} stale=${result.skippedStale} ` +
        `realigned=${result.beliefsRealigned} contended=${result.skippedContended} ` +
        `edges=${result.supportEdges})`,
    );
    return result;
  }

  /**
   * One (userId, subject, field) verdict: create / corroborate / revise.
   *
   * Every write that changes what the belief SAYS goes through ONE
   * compare-and-set transaction (commitRevision, belief-revision.ts): the
   * new revision row and the supersede stamp on the head land together or
   * not at all, and a head that moved under this run — another pod
   * revised the same key first — aborts the transaction instead of
   * leaving two active revisions or a revision slot silently holding
   * someone else's value. The stamps that follow (consolidatedInto,
   * baselineRef, support edges) are replay-idempotent and re-asserted on
   * every run, so a crash between the transaction and the stamps heals on
   * the next pass.
   *
   * TWO CLOCKS (audit 2026-09-06 F6). `validFrom` is when the current
   * state BEGAN; `latestEvidenceAt` (0137) is the WATERMARK — the latest
   * scene the belief has processed for its value. A confirmation advances
   * the watermark and leaves the beginning alone; a differing candidate
   * is measured against the watermark, so evidence older than what the
   * belief already saw can never revise it, whatever order it arrived in.
   */
  private async upsertBelief({
    db,
    belief,
    promoterVersion: runPromoterVersion,
    edgesOn,
    result,
  }: {
    db: BeliefDb;
    belief: FoldedBelief;
    promoterVersion: string;
    edgesOn: boolean;
    result: BeliefPromotionResult;
  }): Promise<void> {
    // Per-belief stamp: identical to the run stamp unless this belief
    // came wholly out of ONE pack world (promoterVersionFor).
    const promoterVersion = promoterVersionFor(belief, runPromoterVersion);
    const [actives] = await db.query<[ActiveBeliefRow[]]>(
      `SELECT id, revision, value, priorValue, validFrom, latestEvidenceAt,
              sourceSceneIds, conversationIds
         FROM semantic_belief
        WHERE userId = $u AND subject = $s AND field = $f AND status = 'active'
        ORDER BY revision DESC`,
      { u: belief.userId, s: belief.subject, f: belief.field },
    );
    const head = (actives ?? [])[0];
    // Self-heal a pre-0137 crash window (revision created, supersede
    // stamp lost — impossible since the two became one transaction, but
    // rows written before that can still carry it): every active row
    // below the highest revision is stamped superseded.
    for (const dangling of (actives ?? []).slice(1)) {
      this.logger.warn(
        `belief promotion: repairing dangling active revision ${dangling.revision} ` +
          `of (${belief.subject}, ${belief.field})`,
      );
      await db.query(
        `UPDATE $id SET status = 'superseded', supersededBy = $winner,
                        validUntil = $until, updatedAt = time::now()`,
        {
          id: new StringRecordId(String(dangling.id)),
          winner: new StringRecordId(String(head!.id)),
          until: head!.validFrom,
        },
      );
    }

    if (!head) {
      const committed = await commitRevision({
        db,
        belief,
        revision: 1,
        promoterVersion,
        statement: await this.composeStatement(belief),
        logger: this.logger,
      });
      if (!committed) {
        result.skippedContended += 1;
        return;
      }
      await this.stampScenes(db, belief.sceneIds, beliefRecordString(belief, 1));
      if (edgesOn) {
        result.supportEdges += await this.writeEdges(db, promoterVersion, [
          {
            kind: 'supported_by' as const,
            pairs: belief.sceneIds.map((s) => ({ in: beliefRecordString(belief, 1), out: s })),
          },
        ]);
      }
      result.beliefsCreated += 1;
      return;
    }

    const headId = String(head.id);
    const headValidFrom = epochMs(head.validFrom);
    // The watermark. A legacy row (pre-0137) carries none: validFrom is
    // then the comparison point — exactly the pre-0137 rule — and the
    // row is stamped on its next corroboration.
    const storedWatermark = epochMs(head.latestEvidenceAt);
    const headWatermark = Number.isFinite(storedWatermark) ? storedWatermark : headValidFrom;

    if (head.value === belief.value) {
      await corroborateBelief({
        db,
        head,
        headId,
        headValidFrom,
        headWatermark,
        belief,
        result,
        logger: this.logger,
      });
      // Stamps + edges are replay-idempotent (array::union / INSERT
      // IGNORE) and always re-asserted so a crash between the belief
      // write and the stamps heals on the next run.
      await this.stampScenes(db, belief.sceneIds, headId);
      if (edgesOn) {
        result.supportEdges += await this.writeEdges(db, promoterVersion, [
          {
            kind: 'supported_by' as const,
            pairs: belief.sceneIds.map((s) => ({ in: headId, out: s })),
          },
        ]);
      }
      return;
    }

    // STALE GUARD against the WATERMARK, not the beginning: a differing
    // value whose own latest evidence is not past what the belief has
    // already processed is older news — A on Jan 1, A again on Mar 1,
    // then B dated Feb 1 arriving late must not displace A. Never revise
    // backward in valid time either (a re-promotion of an older world
    // must not flip-flop the chain).
    if (!Number.isFinite(headWatermark) || belief.evidenceAt.getTime() <= headWatermark) {
      result.skippedStale += 1;
      this.logger.warn(
        `belief promotion stale guard: (${belief.subject}, ${belief.field}) candidate ` +
          `'${belief.value}' with evidence at ${belief.evidenceAt.toISOString()} is not past ` +
          `the active revision ${head.revision} ('${head.value}') watermark ` +
          `${new Date(headWatermark).toISOString()} — group skipped`,
      );
      return;
    }
    // The new state began at the first contribution of its run that is
    // past the head's watermark: a run that started before the head's
    // latest evidence was interrupted by it, and only resumed after.
    const revisionValidFrom =
      belief.runEvidenceAt.find((t) => t.getTime() > headWatermark) ?? belief.evidenceAt;
    if (!Number.isFinite(headValidFrom) || revisionValidFrom.getTime() <= headValidFrom) {
      result.skippedStale += 1;
      this.logger.warn(
        `belief promotion stale guard: (${belief.subject}, ${belief.field}) candidate ` +
          `'${belief.value}' would begin at ${revisionValidFrom.toISOString()}, not after the ` +
          `active revision ${head.revision} ('${head.value}') began — group skipped`,
      );
      return;
    }

    // REVISION — supersede chain in code, never in-place: revision N+1
    // holds the new value; the displaced row gets status/validUntil/
    // supersededBy stamped in the SAME transaction. The ACTUAL displaced
    // value beats the chain's reading as priorValue.
    const revision = head.revision + 1;
    const newId = beliefRecordString(belief, revision);
    const revised: FoldedBelief = {
      ...belief,
      priorValue: head.value,
      validFrom: revisionValidFrom,
    };
    const committed = await commitRevision({
      db,
      belief: revised,
      revision,
      promoterVersion,
      statement: await this.composeStatement(revised),
      displaced: { id: headId, revision: head.revision, until: revisionValidFrom },
      logger: this.logger,
    });
    if (!committed) {
      result.skippedContended += 1;
      return;
    }
    await this.stampScenes(db, belief.sceneIds, newId);
    // The 0106 baselineRef contract, NAMESPACED: the belief revision the
    // delta was applied against lands in `baselineRef.supersededFrom`
    // (revision 1 writes nothing — no baseline existed), and whatever
    // expectation snapshot the enrichment pass left in the same column is
    // PRESERVED rather than overwritten. Merge + writes: scene-baseline-ref.ts.
    await stampSupersededFrom({
      db,
      sceneIds: belief.sceneIds,
      ref: {
        belief: headId,
        revision: head.revision,
        value: head.value,
        stampedAt: new Date().toISOString(),
      },
    });
    if (edgesOn) {
      result.supportEdges += await this.writeEdges(db, promoterVersion, [
        // Old belief is contradicted by the new one (the resolver's
        // loser->winner direction), and the new one derives from it.
        { kind: 'contradicted_by' as const, pairs: [{ in: headId, out: newId }] },
        { kind: 'derived_from' as const, pairs: [{ in: newId, out: headId }] },
        {
          kind: 'supported_by' as const,
          pairs: belief.sceneIds.map((s) => ({ in: newId, out: s })),
        },
      ]);
    }
    result.beliefsRevised += 1;
  }

  /** consolidatedInto ∪= [belief] on the consumed scenes (idempotent). */
  private async stampScenes(db: BeliefDb, sceneIds: string[], beliefId: string): Promise<void> {
    if (sceneIds.length === 0) return;
    // Primary-key addressed (WHERE id INSIDE explicit list) — immune by
    // construction to the 3.2.4 secondary-index planner bug class.
    await db.query(
      `UPDATE memory_episode
          SET consolidatedInto = array::union(consolidatedInto ?? [], [$belief])
        WHERE id INSIDE $sceneIds`,
      {
        belief: new StringRecordId(beliefId),
        sceneIds: sceneIds.map((s) => new StringRecordId(s)),
      },
    );
  }

  /** Shape-validated, deduped, capped, replay-idempotent edge writes. */
  private async writeEdges(
    db: BeliefDb,
    promoterVersion: string,
    specs: Array<{
      kind: 'supported_by' | 'contradicted_by' | 'derived_from';
      pairs: Array<{ in: string; out: string }>;
    }>,
  ): Promise<number> {
    let written = 0;
    for (const spec of specs) {
      const { batches, skipped } = buildSupportEdgeBatches({
        kind: spec.kind,
        writer: 'belief_promotion',
        writerVersion: promoterVersion,
        pairs: spec.pairs,
      });
      if (skipped > 0) {
        this.logger.warn(
          `belief promotion: ${skipped} malformed ${spec.kind} support-edge pair(s) skipped`,
        );
      }
      for (const batch of batches) {
        await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
          rows: batch.map((r) => ({
            ...r,
            in: new StringRecordId(r.in),
            out: new StringRecordId(r.out),
          })),
        });
        written += batch.length;
      }
    }
    return written;
  }

  /** Statement text: deterministic template, optionally LLM-phrased. */
  private async composeStatement(
    belief: FoldedBelief,
  ): Promise<{ text: string; source: 'template' | 'llm' }> {
    const template = renderBeliefStatement(belief);
    if (!sceneBeliefLlmSynthesisEnabled()) return { text: template, source: 'template' };
    if (!this.openai) {
      this.logger.warn('belief statement synthesis skipped: no OPENAI_API_KEY configured');
      return { text: template, source: 'template' };
    }
    // #135 seam 1: the negation clause joins the system prompt only when
    // the flag is on AND the write involves the sentinel (split-constant
    // idiom — flag off, or a non-negation belief, is byte-identical).
    const system =
      sceneBeliefNegationDeltasEnabled() &&
      (belief.value === BELIEF_NEGATION_VALUE || belief.priorValue === BELIEF_NEGATION_VALUE)
        ? BELIEF_SYNTHESIS_SYSTEM + BELIEF_SYNTHESIS_NEGATION_CLAUSE
        : BELIEF_SYNTHESIS_SYSTEM;
    try {
      const res = await this.openai.chat.completions.create({
        model: this.model,
        ...chatCallParams(this.model, { temperature: 0, visibleCap: SYNTHESIS_VISIBLE_CAP }),
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              `subject: ${belief.subject}\nattribute: ${belief.field}\nvalue: ${belief.value}` +
              (belief.priorValue !== '' && belief.priorValue !== belief.value
                ? `\nprevious value: ${belief.priorValue}`
                : ''),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'belief_statement',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { statement: { type: 'string' } },
              required: ['statement'],
            },
          },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) return { text: template, source: 'template' };
      const parsed: unknown = JSON.parse(content);
      const raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).statement
          : undefined;
      const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (text === '') return { text: template, source: 'template' };
      return { text: text.slice(0, STATEMENT_MAX_CHARS), source: 'llm' };
    } catch (e) {
      // Degrade, never fail: the deterministic fold must not depend on
      // the optional synthesis (transport error, malformed reply, ...).
      this.logger.warn(`belief statement synthesis degraded to template: ${(e as Error).message}`);
      return { text: template, source: 'template' };
    }
  }
}
