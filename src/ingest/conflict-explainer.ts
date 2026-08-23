/**
 * Conflict explainer — turns a `fn::resolve_fact` SUPERSEDED/COMPETING
 * outcome into a deterministic narrative that names the dominant
 * scoring dimension and the slots that actually differ between the
 * winner and the strongest loser.
 *
 * Reference: TruthfulRAG (AAAI-26, arXiv:2511.10375) — slot-level
 * conflict localisation. We adopt the slot decomposition + dominant-
 * axis pattern, but the narrative is template-built, not LLM-emitted
 * (per `Attributing Response to Context`, arXiv:2505.16415: post-hoc
 * LLM judgement is unfaithful, balloons storage, and hides causation
 * behind the model's tone).
 *
 * Pure module — no DI, no IO. The ingest service calls
 * `buildConflictExplanation()` after the resolver returns and attaches
 * the result to `IngestResult.conflictExplanation` when the caller
 * requested `explain: true`.
 *
 * Phase 2 scope:
 *   - per-component scoreBreakdown (confidence / source_trust /
 *     recency / authority) for winner and best opponent
 *   - dominantDimension — which axis decided the supersede
 *   - slotDelta — which of {predicate, object, validFrom, source}
 *     actually differ
 *   - narrativeBullet — single-sentence template-rendered explanation
 *
 * Phase 3 will replace `confidence` with `calibratedConfidence` here
 * without changing the shape; Phase 4 will add a `locale` slot to
 * slotDelta.
 */

export type ConflictDimension =
  | 'confidence'
  | 'source_trust'
  | 'recency'
  | 'authority';

export type ConflictOutcome = 'SUPERSEDED' | 'COMPETING';

export interface ConflictScoreBreakdown {
  winner: {
    total: number;
    confidence: number;
    sourceTrust: number;
    recency: number;
    authority: number;
  };
  loser: {
    total: number;
    confidence: number;
    sourceTrust: number;
    recency: number;
    authority: number;
  };
  margin: number;
}

export interface ConflictSlotDelta {
  predicate: boolean;
  object: boolean;
  validFrom: boolean;
  source: boolean;
}

export interface ConflictExplanation {
  outcome: ConflictOutcome;
  winnerFactId: string;
  bestOpponentFactId: string;
  /** All other losers if the resolver supersedes more than one prior fact. */
  otherLoserFactIds: string[];
  dominantDimension: ConflictDimension;
  scoreBreakdown: ConflictScoreBreakdown;
  slotDelta: ConflictSlotDelta;
  /** Single-sentence template explanation suitable for surfacing to a user. */
  narrativeBullet: string;
}

/**
 * Raw resolver shape we consume — keeps this module decoupled from the
 * SurrealDB query layer. The fields named here match what
 * `fn::resolve_fact` (migration 0018) returns on a non-INSERTED,
 * non-REJECTED outcome.
 */
export interface ResolverConflictPayload {
  outcome: ConflictOutcome;
  factId: string;
  bestOpponentId: string;
  supersededFactIds?: string[] | undefined;
  competingFactIds?: string[] | undefined;
  scoreBreakdown: ConflictScoreBreakdown;
  dominantDimension: ConflictDimension;
  slotDelta: ConflictSlotDelta;
}

export function buildConflictExplanation(
  payload: ResolverConflictPayload,
): ConflictExplanation {
  const allLoserIds =
    payload.outcome === 'SUPERSEDED'
      ? (payload.supersededFactIds ?? [])
      : (payload.competingFactIds ?? []);
  const otherLoserFactIds = allLoserIds.filter(
    (id) => id !== payload.bestOpponentId,
  );

  return {
    outcome: payload.outcome,
    winnerFactId: payload.factId,
    bestOpponentFactId: payload.bestOpponentId,
    otherLoserFactIds,
    dominantDimension: payload.dominantDimension,
    scoreBreakdown: payload.scoreBreakdown,
    slotDelta: payload.slotDelta,
    narrativeBullet: renderNarrative(payload),
  };
}

/**
 * Deterministic single-sentence narrative. Templates are picked by
 * (outcome × dominantDimension) and parameterised by the score gap and
 * the meaningful slot deltas. Keeps the narrative short — one line
 * per IngestResult — and never invents reasons the breakdown didn't
 * carry.
 */
function renderNarrative(payload: ResolverConflictPayload): string {
  const gap = payload.scoreBreakdown.margin;
  const gapStr = gap >= 0 ? `+${gap.toFixed(3)}` : gap.toFixed(3);
  const verbBase =
    payload.outcome === 'SUPERSEDED' ? 'superseded' : 'competes with';
  const dim = payload.dominantDimension;
  const deltaSlots = describeSlotDelta(payload.slotDelta);

  const dimPhrase = dimPhraseFor(dim);
  const slotPhrase = deltaSlots.length
    ? ` differs by ${deltaSlots.join(' + ')}`
    : '';

  return `New fact ${verbBase} the strongest prior (gap ${gapStr} on ${dimPhrase})${slotPhrase}.`;
}

function dimPhraseFor(dim: ConflictDimension): string {
  switch (dim) {
    case 'confidence':
      return 'confidence';
    case 'source_trust':
      return 'source trust';
    case 'recency':
      return 'recency';
    case 'authority':
      return 'authority';
  }
}

function describeSlotDelta(slot: ConflictSlotDelta): string[] {
  const slots: string[] = [];
  if (slot.object) slots.push('object');
  if (slot.validFrom) slots.push('validFrom');
  if (slot.source) slots.push('source');
  // `predicate` is always equal for any non-trivial conflict (the
  // resolver filters by predicate); skip it from the rendered list.
  return slots;
}
