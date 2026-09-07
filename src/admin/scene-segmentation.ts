import { createHash } from 'node:crypto';
import { cosineSimilarity } from '../common/vector-math';
import type { EpisodeRow } from '../episodes/session-window';

/**
 * Pure scene segmentation + deterministic rendering/scoring for the
 * Brain v2 shadow Scenes substrate (memory_episode, migration 0106).
 *
 * No NestJS, no DB, no env reads — mirrors session-window.ts: the
 * composer (scene-composer.service.ts) resolves flags/knobs and passes
 * plain values in. Sessions come PRE-SPLIT via segmentSessions (the
 * shared 60-min-gap convention) — `detectSceneBoundaries` works WITHIN
 * one session; the session gap itself is therefore always a scene
 * boundary by construction. Everything here is deterministic: the same
 * turns (and the same embeddings, when provided) always produce the
 * same scenes, gists, labels, and scores.
 */

/**
 * Version stamp of the CURRENT deterministic segmenter. Lives in this
 * pure module (PR2) so the composer, the LLM enricher and the fact
 * backlinker can all name "the current scene world" without importing
 * each other — the composer re-exports it for API continuity.
 */
export const SEGMENTER_VERSION = 'scene-segmenter-v1';

/** Member turn shape — the raw L0 read row (piiClass rides for folding). */
export interface SceneTurnRow extends EpisodeRow {
  piiClass?: string[];
}

/** Options for the within-session boundary detector. */
export interface SceneBoundaryOpts {
  /** Split when cosine(mean of last 3 turns, next turn) < this floor. */
  minCosine: number;
  /** Force a boundary once a scene reaches this many turns. */
  maxTurns: number;
}

/** Trailing-context width for the topic-boundary cosine test. */
const TOPIC_TAIL_TURNS = 3;
/** A cosine split never leaves a scene shorter than this. */
const MIN_SCENE_TURNS = 2;

/** Element-wise mean of equal-length vectors ([] for empty input). */
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim && i < v.length; i++) out[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}

/**
 * How ONE scene edge came to be. Two families, and the distinction is the
 * whole point of the confidence derivation below:
 *
 *  - 'session'   — the session gap (or the conversation's own start/end).
 *                  Sessions are pre-split upstream by segmentSessions, so
 *                  every scene at a session edge inherits that exact rule.
 *  - 'max-turns' — the SCENES_MAX_TURNS cap fired. Also an exact rule: the
 *                  scene reached N turns, which is not a judgement call.
 *  - 'topic-cosine' — the embedding-based within-session split fired, i.e.
 *                  cosine(mean of the trailing turns, next turn) fell below
 *                  the floor. The ONLY inexact edge the segmenter can make,
 *                  and it carries the cosine that fired it.
 */
export type SceneBoundaryKind = 'session' | 'max-turns' | 'topic-cosine';

export interface SceneBoundary {
  kind: SceneBoundaryKind;
  /** The cosine that fired a 'topic-cosine' split; absent for exact rules. */
  cosine?: number;
}

/** One scene plus the two edges that delimit it. */
export interface SceneSegment<T extends SceneTurnRow> {
  turns: T[];
  startBoundary: SceneBoundary;
  endBoundary: SceneBoundary;
}

const SESSION_BOUNDARY: SceneBoundary = { kind: 'session' };

/**
 * Pure: split ONE session's time-ordered turns into scenes, KEEPING the
 * rule that made each edge (the confidence input — see
 * `deriveSceneConfidence`). `detectSceneBoundaries` is the turns-only
 * projection of this function and stays the shape every existing caller
 * uses; the segmentation itself is byte-identical between the two.
 *
 *  - Without embeddings: a single scene, force-split at maxTurns — the
 *    session gap (handled upstream by segmentSessions) is the only
 *    semantic boundary the embedder-free mode knows.
 *  - With embeddings (parallel to `turns`, entries may be missing):
 *    additionally split between turn i-1 and i when cosine(mean of the
 *    last TOPIC_TAIL_TURNS turns' embeddings, embedding[i]) < minCosine,
 *    never leaving a scene shorter than MIN_SCENE_TURNS.
 *  - Always force-split at maxTurns, embeddings or not.
 */
export function detectSceneSegments<T extends SceneTurnRow>(
  sessionTurns: T[],
  embeddings: Array<number[] | undefined> | undefined,
  opts: SceneBoundaryOpts,
): Array<SceneSegment<T>> {
  if (sessionTurns.length === 0) return [];
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns));
  const segments: Array<SceneSegment<T>> = [];
  let current: T[] = [sessionTurns[0]!];
  let currentStart = 0;
  // The first scene of a session begins at the session edge by construction.
  let startBoundary: SceneBoundary = SESSION_BOUNDARY;
  for (let i = 1; i < sessionTurns.length; i++) {
    let boundary: SceneBoundary | undefined;
    if (current.length >= maxTurns) {
      boundary = { kind: 'max-turns' };
    } else if (embeddings && current.length >= MIN_SCENE_TURNS) {
      const tailFrom = Math.max(currentStart, i - TOPIC_TAIL_TURNS);
      const tail: number[][] = [];
      for (let j = tailFrom; j < i; j++) {
        const v = embeddings[j];
        if (v) tail.push(v);
      }
      const next = embeddings[i];
      if (tail.length > 0 && next) {
        const cosine = cosineSimilarity(meanVector(tail), next);
        if (cosine < opts.minCosine) boundary = { kind: 'topic-cosine', cosine };
      }
    }
    if (boundary) {
      // One edge, two scenes: it ends the current scene and starts the next.
      segments.push({ turns: current, startBoundary, endBoundary: boundary });
      startBoundary = boundary;
      current = [];
      currentStart = i;
    }
    current.push(sessionTurns[i]!);
  }
  segments.push({ turns: current, startBoundary, endBoundary: SESSION_BOUNDARY });
  return segments;
}

/** Pure: `detectSceneSegments` without the edge provenance. */
export function detectSceneBoundaries<T extends SceneTurnRow>(
  sessionTurns: T[],
  embeddings: Array<number[] | undefined> | undefined,
  opts: SceneBoundaryOpts,
): T[][] {
  return detectSceneSegments(sessionTurns, embeddings, opts).map((s) => s.turns);
}

/**
 * Pure: how sure the segmenter is about ONE edge, in [0.5, 1].
 *
 * CASE 1 — an EXACT rule made it ('session', 'max-turns'): confidence 1.
 * This is not optimism, it is arithmetic. "The gap between these turns
 * exceeded 60 minutes" and "this scene reached SCENES_MAX_TURNS turns" are
 * propositions the segmenter evaluates with certainty; there is no model in
 * the loop to be unsure about. A number below 1 there would be a made-up
 * discount on a decision that cannot be wrong on its own terms.
 *
 * CASE 2 — the topic-cosine split made it: the edge exists because the
 * cosine fell BELOW the floor, so how far below is exactly how strong the
 * evidence was. The margin is `minCosine - cosine`, and the widest margin
 * the test can ever produce is `minCosine - (-1)`; the ratio is mapped onto
 * [0.5, 1]:
 *
 *     confidence = 0.5 + 0.5 · (minCosine − cosine) / (minCosine + 1)
 *
 * A split that barely cleared the floor lands at ~0.5 — the boundary is a
 * coin-flip and the row now says so. A split between genuinely opposed
 * turns approaches 1. The floor of 0.5 is deliberate: the rule DID fire, so
 * the edge is never evidence AGAINST itself.
 */
export function boundaryConfidence(boundary: SceneBoundary, minCosine: number): number {
  if (boundary.kind !== 'topic-cosine' || boundary.cosine === undefined) return 1;
  const span = minCosine + 1;
  // Unreachable in practice (cosine ≥ -1 can never fall below a -1 floor),
  // but a zero-width span must not produce a division by zero.
  if (span <= 0) return 1;
  const derived = 0.5 + (0.5 * (minCosine - boundary.cosine)) / span;
  return Math.min(1, Math.max(0.5, derived));
}

/**
 * Pure: the scene's own confidence — the WEAKER of its two edges, because a
 * scene is only as well-delimited as its shakiest boundary.
 *
 * With SCENES_TOPIC_BOUNDARY off no cosine edge can exist (no embedding is
 * ever taken), so every scene is delimited by session gaps and the turn cap
 * alone and this returns exactly 1 for all of them — byte-identical to the
 * hardcoded `confidence: 1` the composer wrote before the derivation
 * existed. With the boundary on, only scenes that an actual cosine split
 * touched move off 1.
 */
export function deriveSceneConfidence<T extends SceneTurnRow>(
  segment: SceneSegment<T>,
  opts: { minCosine: number; topicBoundary: boolean },
): number {
  if (!opts.topicBoundary) return 1;
  return Math.min(
    boundaryConfidence(segment.startBoundary, opts.minCosine),
    boundaryConfidence(segment.endBoundary, opts.minCosine),
  );
}

/**
 * Assistant-role detection: case-insensitive speaker SUFFIX, matching the
 * assistant-lane convention (retrieval-profile.ts assistantLaneMatch —
 * harness speakers are `<convSlug>__<role>`). A scene of only assistant
 * turns falls back to its first turn.
 */
function isAssistantSpeaker(speaker: string | undefined): boolean {
  return (speaker ?? '').toLowerCase().endsWith('assistant');
}

function firstNonAssistant<T extends SceneTurnRow>(turns: T[]): T {
  return turns.find((t) => !isAssistantSpeaker(t.speaker)) ?? turns[0]!;
}

/** Deterministic trim: collapse whitespace runs, cut at `max` chars. */
function trimTo(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

const OPENER_CLOSER_CHARS = 160;
const LABEL_CHARS = 80;

function isoOf(occurredAt: string | Date): string {
  return occurredAt instanceof Date ? occurredAt.toISOString() : new Date(occurredAt).toISOString();
}

/**
 * Canonical deterministic scene gist TEXT:
 *   `<YYYY-MM-DD HH:mm>–<HH:mm> · <speakers> · <N> turns — opens: "…" — closes: "…"`
 * UTC timestamps; speakers are distinct, in order of first appearance.
 * PII-safe by construction — member turns are already redacted at capture
 * (0073), and the gist only ever quotes member text verbatim.
 */
export function renderSceneGist(turns: SceneTurnRow[]): string {
  const first = turns[0]!;
  const last = turns[turns.length - 1]!;
  const fromIso = isoOf(first.occurredAt);
  const toIso = isoOf(last.occurredAt);
  const speakers = [...new Set(turns.map((t) => t.speaker ?? 'unknown'))].join(', ');
  const opens = trimTo(firstNonAssistant(turns).text, OPENER_CLOSER_CHARS);
  const closes = trimTo(last.text, OPENER_CLOSER_CHARS);
  return (
    `${fromIso.slice(0, 10)} ${fromIso.slice(11, 16)}–${toIso.slice(11, 16)} · ` +
    `${speakers} · ${turns.length} turns — opens: "${opens}" — closes: "${closes}"`
  );
}

/** Deterministic scene label: first non-assistant turn, trimmed to 80. */
export function renderSceneLabel(turns: SceneTurnRow[]): string {
  return trimTo(firstNonAssistant(turns).text, LABEL_CHARS);
}

/** Version stamp of the deterministic scorer below. */
export const SCENE_SCORER_VERSION = 'scene-scorer-v0';

/** Partial per-dimension memory value (migration 0106 memoryValue). */
export interface SceneMemoryValue {
  novelty?: number;
  contradiction?: number;
  stateChange?: number;
  identity?: number;
  explicitness?: number;
  estimatedUtility?: number;
  scorerVersion: string;
  scoredAt: Date;
}

/**
 * First-person-declarative markers for the explicitness dimension — a
 * deliberately small, documented v0 heuristic (English + Russian). Two
 * patterns because `\b` is ASCII-only and never fires around Cyrillic:
 * the second uses explicit non-letter guards instead of word boundaries.
 */
const FIRST_PERSON_PATTERNS: readonly RegExp[] = [
  /\b(i|i'm|i've|i'd|my|mine|me)\b/i,
  /(?:^|[^а-яё])(я|мне|меня|мой|моя|моё|мои|нам|наш)(?=[^а-яё]|$)/i,
];

/**
 * Deterministic (LLM-free) partial memory-value scoring:
 *  - novelty: 1 − max cosine(scene centroid, prior scene centroids) —
 *    computed ONLY when the centroid exists (i.e. embeddings ran); with
 *    no priors the scene is maximally novel (1).
 *  - explicitness: fraction of member turns carrying a first-person
 *    declarative marker (FIRST_PERSON_PATTERNS).
 *  - every other dimension stays undefined here.
 *
 * THE OTHER DIMENSIONS NOW HAVE A PRODUCER, just not at compose time.
 * contradiction / stateChange / identity are measured from the scene's
 * stateDeltas against an expectation snapshot of the user's ACTIVE
 * beliefs — neither of which exists yet when this runs (stateDeltas are
 * enrichment-owned, migration 0118, and a scene has not been read here).
 * That scorer is `scorePredictionError` (scene-prediction-baseline.ts,
 * SCENE_PREDICTION_SCORER_VERSION 'scene-scorer-v1'); the enricher runs
 * it and lands the result in `enrichedMemoryValue`, because 0118 makes
 * this deterministic vector immutable post-compose. It costs nothing —
 * no model call — it simply cannot run this early.
 *
 * Stamps scorerVersion + scoredAt so mixed-scorer worlds stay auditable.
 */
export function scoreSceneDeterministic(
  sceneCentroid: number[] | undefined,
  priorCentroids: number[][],
  turns: SceneTurnRow[],
): SceneMemoryValue {
  const value: SceneMemoryValue = {
    scorerVersion: SCENE_SCORER_VERSION,
    scoredAt: new Date(),
  };
  if (sceneCentroid && sceneCentroid.length > 0) {
    let maxSim = 0;
    for (const prior of priorCentroids) {
      const sim = cosineSimilarity(sceneCentroid, prior);
      if (sim > maxSim) maxSim = sim;
    }
    value.novelty = 1 - maxSim;
  }
  if (turns.length > 0) {
    const matching = turns.filter((t) =>
      FIRST_PERSON_PATTERNS.some((re) => re.test(t.text)),
    ).length;
    value.explicitness = matching / turns.length;
  }
  return value;
}

/** Scope/PII fold of one scene's member turns (segment-composer rule). */
export interface SceneScopeFold {
  piiClass: string[] | undefined;
  userId: string | undefined;
  userIds: string[];
}

/**
 * Pure: fold the member turns' piiClass/userId into the scene stamp —
 * the SAME rule as the L0 segment composer (segment-composer.service.ts
 * :147-160): piiClass is the union of member tags; userId is stamped only
 * when the whole scene is ONE user's; a mixed-user scene stays
 * tenant-global (userId undefined ⇒ scopeForUser yields []).
 *
 * `userIds` is the SORTED distinct member set (distinctUserScopes
 * idiom) and is PERSISTED on memory_episode (migration 0117): [] means
 * purely tenant-global. Scenes have no serving readers yet, but the
 * 0117 read contract binds future ones — a user-scoped reader must
 * admit a userId-NONE scene only when userIds is [] or CONTAINS the
 * caller, failing closed on userIds IS NONE (see segmentUserGate).
 */
export function foldSceneScope(turns: SceneTurnRow[]): SceneScopeFold {
  const pii = [...new Set(turns.flatMap((t) => t.piiClass ?? []))];
  const userIds = [...new Set(turns.map((t) => t.userId).filter((u): u is string => !!u))].sort();
  return {
    piiClass: pii.length > 0 ? pii : undefined,
    userId: userIds.length === 1 ? userIds[0] : undefined,
    userIds,
  };
}

/**
 * The EFFECTIVE segmenter config — everything that changes what the
 * composer writes for the same input turns. Scene CONTENT depends on these
 * knobs, so scene IDENTITY must too (Drift-3): under
 * SCENES_VERSION_FINGERPRINT the composer derives its effective version
 * from this config via `effectiveSegmenterVersion`, and a knob change
 * forks a NEW id-space instead of overwriting the old world's rows.
 */
export interface SceneSegmenterConfig {
  /** SCENES_TOPIC_BOUNDARY — flips the algorithm AND novelty scoring. */
  topicBoundary: boolean;
  /**
   * SCENES_TOPIC_MIN_COSINE. Ignored — and EXCLUDED from the fingerprint —
   * when !topicBoundary: it cannot affect output there, and including it
   * would fork id-spaces on irrelevant knob changes.
   */
  minCosine: number;
  /** SCENES_MAX_TURNS (resolved positive integer). */
  maxTurns: number;
  /**
   * Canonical embedding-space id (`provider:model:dim:norm`, the 0101
   * idiom via EmbedderService.activeSpaceId). null when !topicBoundary —
   * no embedding is ever taken, so the space cannot affect output.
   */
  embeddingSpaceId: string | null;
}

/**
 * Pure: 8-hex-char sha256 fingerprint over the effective segmenter config.
 * Canonical input string (order fixed, `|`-joined, no JSON):
 *   impl=<SEGMENTER_VERSION> | scorer=<SCENE_SCORER_VERSION>
 *   | maxTurns=<int> | topicBoundary=<0|1>
 *   [ | minCosine=<String(v)> | space=<embeddingSpaceId> ]   // boundary on only
 * The scorer constant is included because `scoreSceneDeterministic` output
 * is stored in the composed row — a scorer bump changes row content and
 * must fork the id-space; being a code constant, the fp moves with the
 * code automatically. Deliberately EXCLUDED: minCosine + embedding space
 * when the boundary is off (cannot affect output), the enrichment
 * prompt/scorer/model (a post-compose revision layer with its own
 * `enrichmentVersion` composite), and `generation` (a per-run
 * observability stamp, 0081 idiom — never part of identity).
 */
export function sceneConfigFingerprint(cfg: SceneSegmenterConfig): string {
  const parts = [
    `impl=${SEGMENTER_VERSION}`,
    `scorer=${SCENE_SCORER_VERSION}`,
    `maxTurns=${cfg.maxTurns}`,
    `topicBoundary=${cfg.topicBoundary ? 1 : 0}`,
  ];
  if (cfg.topicBoundary) {
    parts.push(`minCosine=${String(cfg.minCosine)}`);
    parts.push(`space=${cfg.embeddingSpaceId ?? ''}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
}

/** Pure: `scene-segmenter-v1+<8-hex fp>` — the fingerprinted version. */
export function effectiveSegmenterVersion(cfg: SceneSegmenterConfig): string {
  return `${SEGMENTER_VERSION}+${sceneConfigFingerprint(cfg)}`;
}
