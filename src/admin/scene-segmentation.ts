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
 * Pure: split ONE session's time-ordered turns into scenes.
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
export function detectSceneBoundaries<T extends SceneTurnRow>(
  sessionTurns: T[],
  embeddings: Array<number[] | undefined> | undefined,
  opts: SceneBoundaryOpts,
): T[][] {
  if (sessionTurns.length === 0) return [];
  const maxTurns = Math.max(1, Math.floor(opts.maxTurns));
  const scenes: T[][] = [];
  let current: T[] = [sessionTurns[0]!];
  let currentStart = 0;
  for (let i = 1; i < sessionTurns.length; i++) {
    let boundary = false;
    if (current.length >= maxTurns) {
      boundary = true;
    } else if (embeddings && current.length >= MIN_SCENE_TURNS) {
      const tailFrom = Math.max(currentStart, i - TOPIC_TAIL_TURNS);
      const tail: number[][] = [];
      for (let j = tailFrom; j < i; j++) {
        const v = embeddings[j];
        if (v) tail.push(v);
      }
      const next = embeddings[i];
      if (tail.length > 0 && next) {
        boundary = cosineSimilarity(meanVector(tail), next) < opts.minCosine;
      }
    }
    if (boundary) {
      scenes.push(current);
      current = [];
      currentStart = i;
    }
    current.push(sessionTurns[i]!);
  }
  scenes.push(current);
  return scenes;
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
 *  - every other dimension stays undefined until a paid scorer exists.
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
