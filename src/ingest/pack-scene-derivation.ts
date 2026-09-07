import {
  MM_MAX_CUES,
  MM_MAX_SCENE_SCHEMAS,
  MM_MAX_STATE_MODELS,
  MM_MAX_STATES,
  type PackMemoryModel,
} from '../ai/domain-packs/manifest';

/**
 * Capture-path scene derivation — the MODEL-FREE reader of a pack's
 * declared perception (manifest `memoryModel.sceneSchemas` /
 * `stateModels`) over ONE dialogue turn.
 *
 * The document path gets its scene hypotheses from an external indexer
 * that already read the document; the capture path has no such producer
 * and MUST NOT buy one — a mention is per-turn and latency-sensitive, so
 * no LLM call, no embedding, no IO happens here. What is left is exactly
 * what the manifest promises: `cues` are LITERAL substrings (never
 * regexes, never templates), and declared `states` are a closed
 * vocabulary. So:
 *
 *   * a sceneSchema fires when one of its literal cues occurs in the
 *     turn (case-folded substring — the attention-hints mold);
 *   * a stateModel contributes a delta when its declared states occur as
 *     WHOLE WORDS in the same turn (`under_offer` also matches "under
 *     offer"): the LAST one mentioned is `to`, an earlier different one
 *     is `from`. Declared TRANSITIONS stay ADVISORY — the manifest's
 *     "never a gate" contract — so an undeclared pair still projects.
 *
 * Everything derived here is a CANDIDATE, never truth (the memoryModel
 * contract), and lands in a shadow world no serving path reads.
 *
 * Fences carried over from the document path:
 *   * a schema with no cues can never fire (there is nothing literal to
 *     match, and guessing would need a model);
 *   * a state delta must hang off a scene — with no scene fired for the
 *     pack, its state matches are dropped, exactly like an orphan
 *     `sceneIndex` in a submission.
 *
 * Pure: no env, no IO, no clock. Inputs are treated as UNTRUSTED even
 * though the reader re-validates stored models (the attention-hints
 * posture): a malformed entry is skipped, never thrown on.
 */

/** A state transition read off one turn. */
export interface DerivedPackStateDelta {
  stateModelId: string;
  subject: string;
  from?: string;
  to: string;
  confidence: number;
}

/** One fired scene schema, with the pack's state deltas attached. */
export interface DerivedPackScene {
  schemaId: string;
  label: string;
  gist: string;
  confidence: number;
  stateDeltas: DerivedPackStateDelta[];
}

/** Manifest bound: a cue is a literal of 2..64 chars. */
const CUE_MIN = 2;
const CUE_MAX = 64;
/** A 2-char state token would match half the alphabet — require 3. */
const STATE_MIN = 3;
/** 0106 sceneLabel budget (the composer/0110 cap). */
const LABEL_MAX = 200;
/** Gist budget for a single turn — the scene quotes, it does not archive. */
export const DERIVED_GIST_MAX = 500;
/** One cue matched = a weak hypothesis; each extra cue firms it up. */
const SCENE_CONFIDENCE_BASE = 0.5;
const SCENE_CONFIDENCE_STEP = 0.1;
const SCENE_CONFIDENCE_MAX = 0.9;
/** A bare destination state; +STEP when an origin state is present too. */
const DELTA_CONFIDENCE_BASE = 0.5;

/** Case-fold for the literal cue test: NFC then locale-independent lower. */
function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function trimTo(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/**
 * Index of `needle` in `hay` as a whole word (both already folded), or -1.
 * Cheaper and safer than a built regex: state tokens are pack-authored
 * strings, and this needs no escaping to stay literal.
 */
function indexOfWord(hay: string, needle: string): number {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at === 0 ? undefined : hay[at - 1];
    const after = hay[at + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return at;
    from = at + 1;
  }
}

/** Literal cues of one schema that occur in the folded turn, in order. */
function matchedCues(schema: { cues?: unknown }, foldedText: string): string[] {
  if (!Array.isArray(schema.cues)) return [];
  const out: string[] = [];
  for (const cue of schema.cues.slice(0, MM_MAX_CUES)) {
    if (typeof cue !== 'string' || cue.length < CUE_MIN || cue.length > CUE_MAX) continue;
    if (foldedText.includes(fold(cue))) out.push(cue);
  }
  return out;
}

/** The declared states of one model that occur in the turn, by position. */
function matchedStates(model: { states?: unknown }, foldedText: string): string[] {
  if (!Array.isArray(model.states)) return [];
  const hits: Array<{ state: string; at: number }> = [];
  for (const state of model.states.slice(0, MM_MAX_STATES)) {
    if (typeof state !== 'string' || state.length < STATE_MIN) continue;
    const folded = fold(state);
    // `under_offer` is declared snake_case but spoken "under offer".
    const spoken = folded.replace(/_/g, ' ');
    const at = [indexOfWord(foldedText, folded), indexOfWord(foldedText, spoken)]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (at !== undefined) hits.push({ state, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.state);
}

/** One model's transition claim for this turn, or null when it is silent. */
function deriveStateDelta(
  model: { id?: unknown; subjectType?: unknown; states?: unknown },
  p: { foldedText: string; subject: string | undefined },
): DerivedPackStateDelta | null {
  if (typeof model.id !== 'string' || model.id === '') return null;
  const states = matchedStates(model, p.foldedText);
  const to = states[states.length - 1];
  if (to === undefined) return null;
  const from = states.length > 1 && states[0] !== to ? states[0] : undefined;
  // Subject fallback: the model's own declared subjectType. The turn's
  // first extracted entity is the caller's better guess when it has one.
  const subjectType = typeof model.subjectType === 'string' ? model.subjectType : model.id;
  const subject = p.subject && p.subject.trim() !== '' ? p.subject : subjectType;
  return {
    stateModelId: model.id,
    subject: trimTo(subject, LABEL_MAX),
    ...(from === undefined ? {} : { from }),
    to,
    confidence: from === undefined ? DELTA_CONFIDENCE_BASE : DELTA_CONFIDENCE_BASE + 0.1,
  };
}

function sceneConfidence(cueHits: number): number {
  return Math.min(
    SCENE_CONFIDENCE_MAX,
    SCENE_CONFIDENCE_BASE + SCENE_CONFIDENCE_STEP * (cueHits - 1),
  );
}

/**
 * Derive one pack's scene candidates for a single turn.
 *
 * Returns [] when nothing literal matched — the common case, and the one
 * that must cost nothing downstream (the producer skips the pack without
 * touching the database).
 */
export function derivePackScenes(p: {
  /** The REDACTED turn text (what the L0 episode row stores). */
  text: string;
  model: PackMemoryModel;
  /** Advisory state-delta subject — the turn's first extracted entity. */
  subject?: string | undefined;
}): DerivedPackScene[] {
  const schemas = Array.isArray(p.model.sceneSchemas) ? p.model.sceneSchemas : [];
  if (schemas.length === 0 || typeof p.text !== 'string' || p.text.trim() === '') return [];
  const foldedText = fold(p.text);
  const gist = trimTo(p.text, DERIVED_GIST_MAX);

  const scenes: DerivedPackScene[] = [];
  for (const schema of schemas.slice(0, MM_MAX_SCENE_SCHEMAS)) {
    if (typeof schema?.id !== 'string' || schema.id === '') continue;
    const cues = matchedCues(schema, foldedText);
    const firstCue = cues[0];
    if (firstCue === undefined) continue;
    scenes.push({
      schemaId: schema.id,
      // Label = the pack's OWN vocabulary (schema id · the cue that
      // fired), so it is informative and PII-free by construction; the
      // turn text lives in the gist, which is already redacted.
      label: trimTo(`${schema.id} · ${firstCue}`, LABEL_MAX),
      gist,
      confidence: sceneConfidence(cues.length),
      stateDeltas: [],
    });
  }
  if (scenes.length === 0) return [];

  // State deltas hang off the FIRST fired scene of the pack: a delta must
  // reference exactly one scene (the document path's sceneIndex fence),
  // and spreading it across every fired schema would double-count it.
  const models = Array.isArray(p.model.stateModels) ? p.model.stateModels : [];
  const deltas: DerivedPackStateDelta[] = [];
  for (const model of models.slice(0, MM_MAX_STATE_MODELS)) {
    const delta = deriveStateDelta(model ?? {}, { foldedText, subject: p.subject });
    if (delta) deltas.push(delta);
  }
  scenes[0]!.stateDeltas = deltas;
  return scenes;
}
