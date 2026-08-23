import type {
  RetrievalGenre,
  RetrievalProfile,
} from './retrieval-profile';

/**
 * Genre presets — per-genre tuned defaults for the measured levers.
 *
 * Precedence contract (strict, resolved per field):
 *
 *   per-company overlay field  >  explicit env key  >  genre preset  >
 *   code default
 *
 * A preset value applies ONLY where the corresponding env key is unset;
 * an explicitly SET key — including an explicit '0' on a boolean — is
 * the operator's word and wins over the preset in both directions.
 * When a company overlay changes `genre` itself, the overlay genre
 * resolves FIRST: the preset-backed base is re-derived for THAT genre,
 * then the remaining overlay fields apply on top
 * (`resolveRetrievalProfileFor`).
 *
 * Inclusion rules (owner directive, 2026-08-21) — a lever enters a
 * genre's preset ONLY if:
 *   1. the profile field exists in RetrievalProfile today (no new
 *      dimensions, no new env keys — the flag-budget goldens are
 *      byte-frozen);
 *   2. the roadmap docs record a measured POSITIVE for that lever on
 *      that genre's benchmark family (LoCoMo → dialogue;
 *      LongMemEval/BEAM assistant chats → assistant_chat);
 *   3. no conflicting negative is recorded on the same genre.
 * In doubt → leave the lever out. Each entry carries its doc anchor.
 *
 * Deliberately preset-INELIGIBLE fields: `genre` itself and `lanes`
 * (structural, not tuning), numeric caps/budgets and string knobs
 * (deployment tuning, not genre semantics), and the infra execution
 * modes (`coverageScanMode`/`coverageLexMode`/`scanHnsw*` — enable
 * ritual per tenant, never per genre).
 *
 * This module reads NO env keys — it is pure data; resolution threading
 * lives in retrieval-profile.ts (the one engine file allowed to read
 * the environment).
 */
export type GenrePreset = Partial<
  Pick<
    RetrievalProfile,
    | 'verbatimEvidence'
    | 'insightEvidence'
    | 'timelineEvidence'
    | 'dateAnchoring'
    | 'temporalMode'
    | 'abstentionCalibration'
    | 'digestLanes'
    | 'segmentRerank'
    | 'factRerank'
    | 'mentionDates'
    | 'sceneTraces'
    | 'enumStrict'
    | 'wideProbe'
    | 'entityExpansion'
    | 'salienceScoring'
    | 'updateStoryRendering'
    | 'orderingFrame'
    | 'verifierTopicCoverage'
    | 'digestEvidence'
    | 'rawWindow'
    | 'assistantLane'
    | 'factsAsKeys'
    | 'timeFilter'
    | 'dateMath'
    | 'answerConditioning'
    | 'noiseFilter'
    | 'searchLoop'
    | 'l3Escalation'
  >
>;

export const GENRE_PRESETS: Record<RetrievalGenre, GenrePreset> = {
  dialogue: {
    // Genre law, measured twice (typed-answer-dispatch-2026-07.md §3):
    // segment lane +3.8pp on LoCoMo two-human dialogue (vs −28pp
    // LongMemEval / −18.6pp BEAM on assistant chats — never preset
    // there); 'always' is the diary-genre profile, the old lane flags ON.
    verbatimEvidence: 'always',
    // LoCoMo-convention golds: date context measurably hurts —
    // −7.1pp by gold convention (typed-answer-dispatch-2026-07.md §3);
    // "LoCoMo-convention eval profiles must pin =0"
    // (measure-ladder-2026-08-results.md E2); armK guard: session-date
    // defaults ARE the LoCoMo answer convention
    // (memory-research-2026-08.md §5).
    dateAnchoring: 'none',
  },
  assistant_chat: {
    // Dual-trace scene anchors: +20.2pp LongMemEval-S overall
    // (95% CI +12.1..+29.3; temporal +40pp, KU +25pp, multi-session
    // +30pp) in the controlled pair (memory-research-2026-08.md §5 B10
    // + §7). Read-side render only — byte-identical against worlds
    // derived without the DERIVER_SCENE_TRACE stamp.
    sceneTraces: true,
    // The V9 verdict-decline win: +17.5pp on the abstention row, BEAM
    // first-person assistant chats (v10-audit-2026-08.md, test-pin
    // registry; "our 'verifier' arm at 0.85 is competitive with
    // anything published"). Zero marginal model calls — the verifier
    // already runs in lenient guardrails; 'answer' mode stays exempt.
    abstentionCalibration: 'verifier',
  },
  // The documents axis is unmeasured — "we have NO non-conversational
  // eval axis" (memory-research-2026-08.md §6). Pure code defaults
  // until a documents-genre eval exists.
  documents: {},
};
