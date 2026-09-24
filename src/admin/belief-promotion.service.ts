import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { retryOnUniqueViolation } from '../db/surreal-retry';
import {
  chatCallParams,
  offlineServiceTier,
  chatModel,
  createOpenAiClient,
} from '../ai/openai-client';
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
import { predicateIdFromFieldName } from '../common/attribute-names';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
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
  /** The written attribute name — what the prompt and the read API show. */
  field: string;
  /**
   * The registry slot this belief occupies (0147) — the SAME identity a
   * fact carries as `(predicateAlias ?? predicate)`. Equal to `field`
   * when the service could not resolve one, which is how a pre-0147 row
   * behaves: no cross-plane join, never a wrong one.
   */
  predicateId: string;
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
  /**
   * Field names that resolved to a DIFFERENT registry slot (0147) — the
   * belief-side half of the one vocabulary both planes share.
   *
   * There is no ambiguity list any more. The lexical rule this replaced
   * could match a name against several existing ones at once and had to
   * refuse the whole fold and warn; a registry lookup returns exactly one
   * canon, or nothing.
   */
  fieldFolds: Array<{ userId: string; subject: string; from: string; to: string }>;
}

/** Fold behavior knobs, resolved ONCE per run (the Drift-3 contract). */
export interface BeliefFoldOptions {
  /** SCENES_BELIEF_NEGATION_DELTAS: admit empty-`to` removal deltas. */
  negationDeltas?: boolean;
  /**
   * Raw field name → the registry slot it resolved to (0147). Built by
   * the service, which owns the IO, so this module stays pure.
   *
   * This REPLACED a lexical token-subset rule over a hand-written
   * six-word stoplist of "generic modifiers", which decided on its own
   * whether two free-text field names denoted one attribute. Measured
   * against the twelve field names a live tenant actually held, that
   * rule folded ZERO pairs and missed all three it existed to catch —
   * `deployment target` ~ `deployment platform` (AWS ECS Fargate beside
   * Fly.io), `job queue backend` ~ `queue backend` (Redis Streams beside
   * NATS JetStream), `pilot launch date` ~ `date`. Its own doc admitted
   * two of those as accepted limitations.
   *
   * The registry answers the same question for the fact plane, with
   * cosine over the seed ontology at coinage and the consolidation pass
   * over the whole vocabulary afterwards. Routing belief fields through
   * it gives both planes ONE vocabulary and one slot identity, which is
   * also what makes the damping join possible at all. Undefined ⇒
   * exact-string grouping on the raw field, the historical behaviour.
   */
  fieldSlots?: ReadonlyMap<string, string>;
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
  fieldFolds: Map<string, BeliefFold['fieldFolds'][number]>;
}

/**
 * The registry slot one delta's field resolved to (0147), looked up
 * BEFORE the group key is built so negation and slot resolution compose.
 * Records a fold whenever the slot differs from the written name, which
 * is what the log reports.
 *
 * A field the service could not resolve — nothing survived the token
 * floor, or the registry was unreachable — is absent from the map and
 * keeps its written name as the group key. That is exactly the
 * pre-0147 behaviour, and it degrades to "this belief does not join the
 * fact plane", never to a wrong join.
 */
function slotForField(
  { userId, subject, field }: { userId: string; subject: string; field: string },
  fieldSlots: ReadonlyMap<string, string>,
  state: FieldFoldState,
): string {
  const slot = fieldSlots.get(field);
  if (slot === undefined || slot === '' || slot === field) return field;
  state.fieldFolds.set(`${userId}\u0000${subject}\u0000${field}`, {
    userId,
    subject,
    from: field,
    to: slot,
  });
  return slot;
}

type BeliefGroups = Map<
  string,
  {
    userId: string;
    subject: string;
    /** The written name, first contribution's — display only. */
    field: string;
    /** The registry slot this group keys on (0147). */
    predicateId: string;
    contributions: BeliefContribution[];
  }
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
    const slot =
      opts.fieldSlots !== undefined
        ? slotForField({ userId, subject, field: rawField }, opts.fieldSlots, foldState)
        : rawField;
    // The group key is the SLOT; `field` stays the written name, and the
    // first contribution's wins. Identity and presentation are separate
    // for a reason: the prompt reads better as "deployment target = AWS
    // ECS Fargate" than as "deploy_target = ...", while only the slot can
    // be compared with a fact.
    const key = `${userId}\u0000${subject}\u0000${slot}`;
    let group = groups.get(key);
    if (!group) {
      group = { userId, subject, field: rawField, predicateId: slot, contributions: [] };
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
  predicateId: string;
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
      predicateId: group.predicateId,
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
  const foldState: FieldFoldState = { fieldFolds: new Map() };
  for (const { scene, userId } of scenes) {
    const head = sceneFoldContext(scene);
    if (head === null) continue; // unordered scene: unusable
    collectSceneDeltas({ scene, userId, head, opts, foldState, groups });
  }

  const fold: BeliefFold = {
    folded: [],
    conflicts: [],
    fieldFolds: [...foldState.fieldFolds.values()],
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
  /** Foldable-variant orphan beliefs superseded into the canonical one. */
  /** Second active rows retired out of a slot (0147). */
  slotDuplicatesRetired: number;
  /** Orphan sweeps skipped: >1 distinct foldable field (never merged). */
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

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly surreal: SurrealService,
    configService: ConfigService,
    private readonly versions: SceneVersionService,
    private readonly predicates: PredicateRegistryService,
  ) {
    this.openai = createOpenAiClient(configService);
    this.model = configService.get<string>('SCENES_BELIEF_MODEL', chatModel(configService));
  }

  /**
   * Every DISTINCT field name this batch mentions → the registry slot it
   * resolves to (0147). Built here, where the IO lives, and handed to the
   * pure fold as a plain map.
   *
   * Free text becomes a predicate id first (predicateIdFromFieldName:
   * `deployment target` → `deployment_target`), then the registry decides
   * identity exactly as it does for a fact predicate — an existing name
   * or a known alias answers from the cached snapshot with no model call,
   * and a genuinely novel one is coined `proposed` and folded later by
   * PredicateConsolidationService. That is the whole point: ONE
   * vocabulary, one pass maintaining it, both planes.
   *
   * FAIL-OPEN, PER NAME. A field that survives nothing of the token
   * floor, or one whose canonicalize throws, is simply absent from the
   * map and keeps its written name as the group key — the pre-0147
   * behaviour, which costs the cross-plane join for that one attribute
   * and never produces a wrong join. A registry outage must not stop a
   * promotion pass.
   */
  private async resolveFieldSlots(
    companyId: string,
    input: ReadonlyArray<{ scene: PromotableSceneHead; userId: string }>,
  ): Promise<Map<string, string>> {
    // One entry per distinct written name, with a sample value for the
    // embedding context — the same `<predicate>: <object>` shape the fact
    // plane embeds, so both planes land in one vector space.
    const samples = new Map<string, string>();
    for (const { scene } of input) {
      for (const delta of Array.isArray(scene.stateDeltas) ? scene.stateDeltas : []) {
        if (typeof delta !== 'object' || delta === null) continue;
        const d = delta as Record<string, unknown>;
        const field = str(d.field);
        if (field === '' || samples.has(field)) continue;
        samples.set(field, str(d.to) || str(d.from));
      }
    }
    const slots = new Map<string, string>();
    for (const [field, sample] of samples) {
      const id = predicateIdFromFieldName(field);
      if (id === '') continue;
      try {
        const decision = await this.predicates.canonicalize(companyId, id, {
          text: sample === '' ? id : `${id}: ${sample}`,
        });
        slots.set(field, decision.canonicalId);
      } catch (e) {
        this.logger.warn(
          `belief promotion: could not resolve field '${field}' to a registry slot ` +
            `(${(e as Error).message}); keeping the written name`,
        );
      }
    }
    return slots;
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
      slotDuplicatesRetired: 0,
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

      // 0147: resolve every distinct field name this batch mentions to a
      // registry slot BEFORE the pure fold runs — the fold stays pure and
      // the IO stays here.
      //
      // One call per DISTINCT name, not per delta, and canonicalize
      // answers a name the registry already knows straight from the
      // cached snapshot with no model call. Measured on a live tenant, 6
      // of its 12 belief field names resolved to a predicate the fact
      // plane had already coined and 4 landed on a slot a fact was
      // already sitting in — against 0 of 12 under the lexical rule this
      // replaced. The rest are novel coinages the consolidation pass
      // folds afterwards, exactly as it folded `deployment_target` onto
      // `deploy_target` and `job_queue_backend` onto `queue_backend` on
      // that same tenant's fact plane.
      const fieldSlots = fieldFoldOn
        ? await this.resolveFieldSlots(companyId, foldInput)
        : undefined;

      const chainFold = foldBeliefGroups(foldInput, {
        negationDeltas,
        ...(fieldSlots !== undefined ? { fieldSlots } : {}),
      });
      // A targeted run promotes only the keys its own scenes touch — the
      // rest of the users' chain was context for the fold, not this run's
      // business (its verdicts are unchanged and would only re-stamp).
      const touched = (g: { allSceneIds: string[] }) =>
        foldInput === eligible || g.allSceneIds.some((s) => batchSceneIds.has(s));
      const folded = chainFold.folded.filter(touched);
      const conflicts = chainFold.conflicts.filter(touched);
      const { fieldFolds } = chainFold;
      result.skippedConflict = conflicts.length;
      result.fieldFolds = fieldFolds.length;
      for (const c of conflicts) {
        this.logger.warn(
          `belief promotion conflict guard: (${c.subject}, ${c.field}) for user ${c.userId} ` +
            `has irreconcilable in-batch values [${c.values.join(' | ')}] — group skipped`,
        );
      }
      for (const ff of fieldFolds) {
        this.logger.log(
          `belief promotion slot: field '${ff.from}' resolved to registry predicate ` +
            `'${ff.to}' for subject ${ff.subject} (user ${ff.userId}) — the same slot a ` +
            `fact under that predicate occupies`,
        );
      }

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
      }
    });
    this.logger.log(
      `belief promotion pass: ${result.beliefsCreated} created, ` +
        `${result.beliefsCorroborated} corroborated, ${result.beliefsRevised} revised ` +
        `over ${result.eligibleScenes}/${result.scenes} scene(s) ` +
        `(mixedUser=${result.skippedMixedUser} lowValue=${result.skippedLowValue} ` +
        `conflict=${result.skippedConflict} ` +
        `fieldFolds=${result.fieldFolds} ` +
        `slotDupes=${result.slotDuplicatesRetired} ` +
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
   *
   * A lost compare-and-set is CONTENTION, not a verdict: the head moved
   * between the read and the transaction (another run revised it, or
   * corroborated it into a later watermark), so the decision was taken
   * against a state that no longer exists. Decide again against a fresh
   * read, once — a second loss is counted and the group skipped.
   */
  private async upsertBelief(args: {
    db: BeliefDb;
    belief: FoldedBelief;
    promoterVersion: string;
    edgesOn: boolean;
    result: BeliefPromotionResult;
  }): Promise<void> {
    if ((await this.upsertBeliefOnce(args)) !== 'contended') return;
    if ((await this.upsertBeliefOnce(args)) === 'contended') args.result.skippedContended += 1;
  }

  /** One attempt of the verdict above: 'contended' = nothing written. */
  private async upsertBeliefOnce({
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
  }): Promise<'done' | 'contended'> {
    // Per-belief stamp: identical to the run stamp unless this belief
    // came wholly out of ONE pack world (promoterVersionFor).
    const promoterVersion = promoterVersionFor(belief, runPromoterVersion);
    const [actives] = await db.query<[ActiveBeliefRow[]]>(
      `SELECT id, revision, value, priorValue, field, validFrom, latestEvidenceAt,
              sourceSceneIds, conversationIds
         FROM semantic_belief
        WHERE userId = $u AND subject = $s AND status = 'active'
          AND (predicateAlias ?? predicateId ?? field) = $slot
        ORDER BY revision DESC`,
      { u: belief.userId, s: belief.subject, slot: belief.predicateId },
    );
    const head = (actives ?? [])[0];
    // ONE SLOT, ONE ACTIVE ROW. Every active row below the highest
    // revision is stamped superseded into the head.
    //
    // This used to be a narrow self-heal for a pre-0137 crash window
    // (revision created, supersede stamp lost), and a SECOND mechanism —
    // an "orphan absorb" sweep in its own file — handled the other way a
    // slot ends up with two active rows: a belief written under a
    // different NAME for the same attribute. Since identity moved to the
    // slot (0147) those are the same condition, so they have one fix.
    // The sweep is gone, along with its lexical fold rule, its
    // same-run fence and its ambiguity branch.
    //
    // MARK, NEVER DELETE: serving and the read API only read
    // status='active', the row keeps its provenance (sourceSceneIds),
    // the scenes' consolidatedInto refs stay resolvable, and the GDPR
    // cascades erase by userId regardless of status.
    for (const dangling of (actives ?? []).slice(1)) {
      this.logger.warn(
        `belief promotion: slot '${belief.predicateId}' of (${belief.subject}) held a second ` +
          `active row (revision ${dangling.revision}, written as '${String(dangling.field ?? '')}') ` +
          `— superseded into revision ${head!.revision}`,
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
      result.slotDuplicatesRetired += 1;
      // priorValue backfill — the ONLY way a retired row's value
      // survives: when the head records no prior of its own, the
      // retired row's value becomes it (never when equal to the head's
      // value — a self-prior is meaningless). The statement is NOT
      // rewritten (the 0120 doctrine: never in-place for value/statement).
      const headPrior = typeof head!.priorValue === 'string' ? head!.priorValue.trim() : '';
      const donor = typeof dangling.value === 'string' ? dangling.value.trim() : '';
      const headValue = typeof head!.value === 'string' ? head!.value.trim() : '';
      if (headPrior === '' && donor !== '' && donor !== headValue) {
        await db.query(`UPDATE $id SET priorValue = $prior, updatedAt = time::now()`, {
          id: new StringRecordId(String(head!.id)),
          prior: donor,
        });
        head!.priorValue = donor;
      }
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
      if (!committed) return 'contended';
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
      return 'done';
    }

    const headId = String(head.id);
    const headValidFrom = epochMs(head.validFrom);
    // The watermark. A legacy row (pre-0137) carries none: validFrom is
    // then the comparison point — exactly the pre-0137 rule — and the
    // row is stamped on its next corroboration.
    const storedWatermark = epochMs(head.latestEvidenceAt);
    const headWatermark = Number.isFinite(storedWatermark) ? storedWatermark : headValidFrom;
    // What the supersede predicate compares against: the stored value as
    // read, or nothing at all on a legacy row (`latestEvidenceAt IS NONE`).
    const watermark = Number.isFinite(storedWatermark) ? new Date(storedWatermark) : undefined;

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
      return 'done';
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
      return 'done';
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
      return 'done';
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
      displaced: { id: headId, revision: head.revision, until: revisionValidFrom, watermark },
      logger: this.logger,
    });
    if (!committed) return 'contended';
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
    return 'done';
  }

  /**
   * consolidatedInto ∪= [belief] on the consumed scenes (idempotent).
   *
   * Two promotion runs over one conversation stamp the same scene rows, so
   * this write races and the datastore answers "Resource busy" / read
   * conflict. The union is idempotent, so a retry is always safe: without
   * one the whole promotion pass throws after the belief has already been
   * committed.
   */
  private async stampScenes(db: BeliefDb, sceneIds: string[], beliefId: string): Promise<void> {
    if (sceneIds.length === 0) return;
    // Primary-key addressed (WHERE id INSIDE explicit list) — immune by
    // construction to the 3.2.4 secondary-index planner bug class.
    await retryOnUniqueViolation(() =>
      db.query(
        `UPDATE memory_episode
          SET consolidatedInto = array::union(consolidatedInto ?? [], [$belief])
        WHERE id INSIDE $sceneIds`,
        {
          belief: new StringRecordId(beliefId),
          sceneIds: sceneIds.map((s) => new StringRecordId(s)),
        },
      ),
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
        ...chatCallParams(this.model, {
          tier: offlineServiceTier(),
          temperature: 0,
          visibleCap: SYNTHESIS_VISIBLE_CAP,
        }),
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
