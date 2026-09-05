import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { RecordId, StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { chatCallParams, createOpenAiClient } from '../ai/openai-client';
import {
  sceneBeliefFieldFoldEnabled,
  sceneBeliefLlmSynthesisEnabled,
  sceneBeliefMinScenes,
  sceneBeliefNegationDeltasEnabled,
  sceneBeliefPromotionEnabled,
} from '../common/scene-flags';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildSupportEdgeBatches } from '../common/support-edges';
import { SceneVersionService } from './scene-version';

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
 * CONFLICT GUARD (built-in, no flag): a group whose latest timestamp is
 * shared by two DIFFERENT values has no deterministic winner — the whole
 * (subject, field) group is SKIPPED LOUDLY with a warn. Same for a
 * batch whose winner is not newer than the active belief's validFrom
 * (stale/ambiguous re-promotion — skipped loudly, never flip-flopped).
 *
 * REVISIONS: supersede chain in code, NEVER in-place for values. A new
 * value creates revision N+1 and stamps the old row status='superseded'
 * + validUntil + supersededBy; in-place UPDATE is allowed ONLY for the
 * corroboration counters (sourceSceneIds / conversationIds /
 * corroborationCount / conversationCount / updatedAt). fn::resolve_fact
 * reuse was REJECTED (claim-specific — 0120 header).
 *
 * PROVENANCE: sourceSceneIds is the inline canonical trail (survives
 * flag-off); when PROVENANCE_SUPPORT_EDGES is on, the pass additionally
 * mirrors it into memory_support (supported_by belief->scene) and marks
 * revisions (contradicted_by old->new, derived_from new->old), writer
 * 'belief_promotion' — INSERT RELATION IGNORE, replay-idempotent.
 *
 * SCENE CONTRACTS (0106, finally fulfilled): consumed scenes get
 * consolidatedInto ∪= [belief] (idempotent array::union; column widened
 * to generic records in 0120) and — on a revision ONLY — baselineRef =
 * {belief, revision, value, stampedAt}: the belief revision the delta
 * was applied against. Revision 1 has no baseline (baselineRef stays
 * NONE).
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

/** Promoter identity — composed with the effective scene world below. */
export const BELIEF_PROMOTER_VERSION = 'belief-promotion-v1';

/**
 * Pure: the readable promoter|world composite stamped on belief rows and
 * support edges (the enricher's readable-composite idiom — NOT hashed).
 */
export function beliefPromoterVersion(sceneVersion: string): string {
  return `${BELIEF_PROMOTER_VERSION}|${sceneVersion}`;
}

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
}

/**
 * Pure: the single user a scene's beliefs may inherit, or null when the
 * scene must be skipped fail-closed (#387): userIds missing (legacy),
 * empty (tenant-global), longer than one (mixed group), or disagreeing
 * with the folded userId stamp.
 */
export function sceneSingleUser(scene: PromotableSceneHead): string | null {
  const userIds = scene.userIds;
  if (!Array.isArray(userIds) || userIds.length !== 1) return null;
  const only = userIds[0];
  if (typeof only !== 'string' || only === '') return null;
  if (scene.userId !== only) return null;
  return only;
}

/** One delta occurrence, normalized for the fold. */
export interface BeliefContribution {
  sceneId: string;
  conversationId: string;
  /** Scene occurredTo as epoch ms — the fold's ordering axis. */
  occurredAt: number;
  value: string;
  priorValue: string;
  explicitness: number;
}

/** One promotable (userId, subject, field) verdict out of the fold. */
export interface FoldedBelief {
  userId: string;
  subject: string;
  field: string;
  value: string;
  /** The winner delta's `from` ('' when unknown). */
  priorValue: string;
  validFrom: Date;
  /** Scenes contributing the WINNING value (distinct, emission order). */
  sceneIds: string[];
  /** Distinct conversations behind those scenes — the floor unit. */
  conversationIds: string[];
  confidence: number;
}

export interface BeliefFold {
  folded: FoldedBelief[];
  /** Groups the conflict guard refused (ambiguous latest value). */
  conflicts: Array<{ userId: string; subject: string; field: string; values: string[] }>;
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
 * Generic-modifier stoplist for the field-fold rule (#135 seam 2): the
 * ONLY extra tokens a longer field name may carry and still fold onto a
 * shorter one. Deliberately tiny and conservative — 'car ownership'
 * folds onto 'car' (ownership is generic), 'car registration' does NOT
 * (registration names a DIFFERENT attribute), and 'queue backend' does
 * NOT fold onto 'queue' (backend is specific) — a known limitation we
 * accept over the false-fold risk.
 */
export const FIELD_FOLD_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'ownership',
  'status',
  'state',
  'current',
  'of',
  'the',
]);

/** Normalize a free-text field name: lowercase, strip punctuation, tokenize. */
function fieldTokens(field: string): Set<string> {
  return new Set(
    field
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t !== ''),
  );
}

/**
 * Pure (#135 seam 2): may these two free-text field names denote the
 * same attribute? True ONLY when one token SET is a subset of the other
 * AND every extra token of the longer name is a generic modifier from
 * FIELD_FOLD_GENERIC_TOKENS. Deterministic and lexical — NO embeddings,
 * NO LLM, no stemming ('deploy' ≠ 'deployment' — accepted limitation).
 */
export function fieldsFold(a: string, b: string): boolean {
  const ta = fieldTokens(a);
  const tb = fieldTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  for (const t of large) if (!small.has(t) && !FIELD_FOLD_GENERIC_TOKENS.has(t)) return false;
  return true;
}

/**
 * Pure (#135 seam 2): resolve an incoming field name against the known
 * fields of the same (userId, subject). An exact string match short-
 * circuits (already the canonical name); exactly ONE foldable candidate
 * folds — the EXISTING name wins (stability); MORE than one is
 * ambiguous — fold NOTHING, keep the incoming name (the caller warns
 * loudly: skip loudly, never flip-flop).
 */
export function resolveFieldFold(
  incoming: string,
  knownFields: readonly string[],
): { field: string; folded: boolean; ambiguous: boolean; candidates: string[] } {
  const distinct = [...new Set(knownFields)];
  if (distinct.includes(incoming)) {
    return { field: incoming, folded: false, ambiguous: false, candidates: [] };
  }
  const candidates = distinct.filter((existing) => fieldsFold(incoming, existing));
  if (candidates.length === 1) {
    return { field: candidates[0]!, folded: true, ambiguous: false, candidates };
  }
  if (candidates.length > 1) {
    return { field: incoming, folded: false, ambiguous: true, candidates };
  }
  return { field: incoming, folded: false, ambiguous: false, candidates: [] };
}

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
  return { sceneId, conversationId, occurredAt, explicitness };
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
  if (ambiguous) {
    return {
      conflict: {
        userId: group.userId,
        subject: group.subject,
        field: group.field,
        values: [...new Set(ordered.map((c) => c.value))].sort(),
      },
    };
  }
  const corroborating = ordered.filter((c) => c.value === winner.value);
  const sceneIds = [...new Set(corroborating.map((c) => c.sceneId))];
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
      priorValue: winner.priorValue,
      validFrom: new Date(winner.occurredAt),
      sceneIds,
      conversationIds,
      confidence: Math.round(confidence * 10000) / 10000,
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

/**
 * Pure: deterministic record-id tail over (userId|subject|field|
 * revision) — the composer's sceneIdTail idiom. Paired with INSERT
 * IGNORE it makes every create replay-idempotent, and it enforces
 * (userId, subject, field, revision) uniqueness in CODE — a compound
 * UNIQUE index is exactly the 3.2.4 planner trap 0120 avoids.
 */
export function beliefIdTail(
  key: { userId: string; subject: string; field: string },
  revision: number,
): string {
  return createHash('sha256')
    .update(`${key.userId}\x00${key.subject}\x00${key.field}\x00${revision}`)
    .digest('hex')
    .slice(0, 24);
}

export interface BeliefPromotionResult {
  /** Enriched scenes of the current version seen by the pass. */
  scenes: number;
  /** Scenes that passed the #387 single-user fence into the fold. */
  eligibleScenes: number;
  skippedMixedUser: number;
  /** (subject, field) groups the conflict guard refused. */
  skippedConflict: number;
  /** Field names folded onto an existing one (SCENES_BELIEF_FIELD_FOLD). */
  fieldFolds: number;
  /** Field names left UNfolded because >1 existing field matched. */
  fieldFoldAmbiguous: number;
  /** Groups below the SCENES_BELIEF_MIN_SCENES conversation floor. */
  skippedFloor: number;
  /** Groups whose winner was not newer than the active belief (stale). */
  skippedStale: number;
  beliefsCreated: number;
  beliefsCorroborated: number;
  beliefsRevised: number;
  /** memory_support rows written (0 unless PROVENANCE_SUPPORT_EDGES). */
  supportEdges: number;
}

/** Active-belief head read back for the upsert decision. */
interface ActiveBeliefRow {
  id: unknown;
  revision: number;
  value: string;
  validFrom: unknown;
  sourceSceneIds?: unknown;
  conversationIds?: unknown;
}

interface BeliefDb {
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
      skippedConflict: 0,
      fieldFolds: 0,
      fieldFoldAmbiguous: 0,
      skippedFloor: 0,
      skippedStale: 0,
      beliefsCreated: 0,
      beliefsCorroborated: 0,
      beliefsRevised: 0,
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
    await this.surreal.withCompany(companyId, async (db) => {
      const [scenes] = await db.query<[PromotableSceneHead[]]>(
        `SELECT id, userId, userIds, conversationIds, occurredTo, stateDeltas,
                enrichedMemoryValue.explicitness AS explicitness
           FROM memory_episode
          WHERE segmenterVersion = $v AND enrichmentVersion IS NOT NONE` +
          (opts.conversationId !== undefined ? ` AND conversationIds CONTAINS $conv` : ''),
        {
          v: version,
          ...(opts.conversationId !== undefined ? { conv: opts.conversationId } : {}),
        },
      );
      const eligible: Array<{ scene: PromotableSceneHead; userId: string }> = [];
      for (const scene of scenes ?? []) {
        result.scenes += 1;
        const userId = sceneSingleUser(scene);
        if (userId === null) {
          // #387 fail-closed: mixed-user, tenant-global or legacy
          // (pre-0117 userIds) scenes never feed a belief.
          result.skippedMixedUser += 1;
          this.logger.warn(
            `belief promotion skipped scene ${String(scene.id)}: not single-user ` +
              `(userIds=${JSON.stringify(scene.userIds ?? null)}) — #387 fence`,
          );
          continue;
        }
        result.eligibleScenes += 1;
        eligible.push({ scene, userId });
      }

      // #135 seam 2: fold candidates are the existing ACTIVE belief
      // field names per (userId, subject) — one plain SELECT (safe on
      // the 3.2.4 planner; the DELETE-WHERE trap does not apply to
      // reads). Flag off ⇒ zero extra queries.
      let existingFields: Map<string, string[]> | undefined;
      if (fieldFoldOn && eligible.length > 0) {
        const userIds = [...new Set(eligible.map((e) => e.userId))];
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

      const { folded, conflicts, fieldFolds, fieldFoldAmbiguities } = foldBeliefGroups(eligible, {
        negationDeltas,
        ...(existingFields !== undefined ? { existingFields } : {}),
      });
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
        `(mixedUser=${result.skippedMixedUser} conflict=${result.skippedConflict} ` +
        `fieldFolds=${result.fieldFolds} foldAmbiguous=${result.fieldFoldAmbiguous} ` +
        `floor=${result.skippedFloor} stale=${result.skippedStale} edges=${result.supportEdges})`,
    );
    return result;
  }

  /** One (userId, subject, field) verdict: create / corroborate / revise. */
  private async upsertBelief({
    db,
    belief,
    promoterVersion,
    edgesOn,
    result,
  }: {
    db: BeliefDb;
    belief: FoldedBelief;
    promoterVersion: string;
    edgesOn: boolean;
    result: BeliefPromotionResult;
  }): Promise<void> {
    const [actives] = await db.query<[ActiveBeliefRow[]]>(
      `SELECT id, revision, value, validFrom, sourceSceneIds, conversationIds
         FROM semantic_belief
        WHERE userId = $u AND subject = $s AND field = $f AND status = 'active'
        ORDER BY revision DESC`,
      { u: belief.userId, s: belief.subject, f: belief.field },
    );
    const head = (actives ?? [])[0];
    // Self-heal a crash window (revision created, supersede stamp lost):
    // every active row below the highest revision is stamped superseded.
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
      await this.createRevision({ db, belief, revision: 1, promoterVersion });
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
    // The WS driver returns datetimes as Date instances — never round-trip
    // through String(Date) (the query_arc lesson).
    const headValidFrom =
      head.validFrom instanceof Date
        ? head.validFrom.getTime()
        : new Date(String(head.validFrom)).getTime();

    if (head.value === belief.value) {
      // CORROBORATION — the only in-place update the substrate allows:
      // counters + provenance union, never value/statement/validFrom.
      const knownScenes = (Array.isArray(head.sourceSceneIds) ? head.sourceSceneIds : []).map(
        String,
      );
      const knownConvs = (Array.isArray(head.conversationIds) ? head.conversationIds : []).map(
        String,
      );
      const mergedScenes = [...new Set([...knownScenes, ...belief.sceneIds])];
      const mergedConvs = [...new Set([...knownConvs, ...belief.conversationIds])];
      const newScenes = belief.sceneIds.filter((s) => !knownScenes.includes(s));
      if (newScenes.length > 0) {
        await db.query(
          `UPDATE $id SET sourceSceneIds = $scenes, conversationIds = $convs,
                          corroborationCount = $n, conversationCount = $m,
                          updatedAt = time::now()`,
          {
            id: new StringRecordId(headId),
            scenes: mergedScenes.map((s) => new StringRecordId(s)),
            convs: mergedConvs,
            n: mergedScenes.length,
            m: mergedConvs.length,
          },
        );
        result.beliefsCorroborated += 1;
      }
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

    // Stale/ambiguous batch: never revise BACKWARD in valid time — a
    // re-promotion of an older world must not flip-flop the chain.
    if (!Number.isFinite(headValidFrom) || belief.validFrom.getTime() <= headValidFrom) {
      result.skippedStale += 1;
      this.logger.warn(
        `belief promotion stale guard: (${belief.subject}, ${belief.field}) candidate ` +
          `'${belief.value}' at ${belief.validFrom.toISOString()} is not newer than the ` +
          `active revision ${head.revision} ('${head.value}') — group skipped`,
      );
      return;
    }

    // REVISION — supersede chain in code, never in-place: revision N+1
    // holds the new value; the displaced row gets status/validUntil/
    // supersededBy stamped. The ACTUAL displaced value beats the delta's
    // claimed `from` as priorValue.
    const revision = head.revision + 1;
    const newId = beliefRecordString(belief, revision);
    await this.createRevision({
      db,
      belief: { ...belief, priorValue: head.value },
      revision,
      promoterVersion,
    });
    await db.query(
      `UPDATE $id SET status = 'superseded', supersededBy = $new,
                      validUntil = $until, updatedAt = time::now()`,
      {
        id: new StringRecordId(headId),
        new: new StringRecordId(newId),
        until: belief.validFrom,
      },
    );
    await this.stampScenes(db, belief.sceneIds, newId);
    // The 0106 baselineRef contract: the belief revision the delta was
    // applied against (NONE for revision 1 — no baseline existed).
    await db.query(`UPDATE memory_episode SET baselineRef = $baseline WHERE id INSIDE $sceneIds`, {
      baseline: {
        belief: headId,
        revision: head.revision,
        value: head.value,
        stampedAt: new Date().toISOString(),
      },
      sceneIds: belief.sceneIds.map((s) => new StringRecordId(s)),
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

  /** INSERT IGNORE one revision row (deterministic id — replay-safe). */
  private async createRevision({
    db,
    belief,
    revision,
    promoterVersion,
  }: {
    db: BeliefDb;
    belief: FoldedBelief;
    revision: number;
    promoterVersion: string;
  }): Promise<void> {
    const statement = await this.composeStatement(belief);
    await db.query(`INSERT IGNORE INTO semantic_belief $rows`, {
      rows: [
        {
          id: new RecordId('semantic_belief', beliefIdTail(belief, revision)),
          userId: belief.userId,
          subject: belief.subject,
          field: belief.field,
          value: belief.value,
          ...(belief.priorValue !== '' ? { priorValue: belief.priorValue } : {}),
          statement: statement.text,
          statementSource: statement.source,
          confidence: belief.confidence,
          revision,
          status: 'active',
          validFrom: belief.validFrom,
          sourceSceneIds: belief.sceneIds.map((s) => new StringRecordId(s)),
          conversationIds: belief.conversationIds,
          corroborationCount: belief.sceneIds.length,
          conversationCount: belief.conversationIds.length,
          promoterVersion,
        },
      ],
    });
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

/** Full record-id string for a folded belief at a given revision. */
function beliefRecordString(
  belief: Pick<FoldedBelief, 'userId' | 'subject' | 'field'>,
  revision: number,
): string {
  return `semantic_belief:${beliefIdTail(belief, revision)}`;
}
