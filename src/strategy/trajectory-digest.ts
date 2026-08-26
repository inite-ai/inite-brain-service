import { sanitizePackText } from '../common/text-sanitizer';
import { digestPayload, PAYLOAD_DIGEST_LEN } from '../common/payload-digest';

/**
 * Trajectory digesting for the experience-memory extension of G4 (bet #3,
 * Part 3 of docs/roadmap/measurable-economics-mri-2026-08.md).
 *
 * A "trajectory" is the ordered tool path an agent took to reach an
 * answer, plus whether the run's outcome was verified. We store it as
 * ADVICE (the G4 verifier-parity exception: a trajectory never enters the
 * verifier bundle or citations), and it rides the STRATEGY_TRAJECTORIES_
 * ENABLED flag — default off, byte-identical serving when off.
 *
 * SECURITY POSTURE — DIGESTS, NOT RAW PAYLOADS. Tool args/results are the
 * most likely place for secrets or PII (API keys, tokens, user data). We
 * therefore NEVER store them verbatim: `argsDigest` / `resultDigest` are
 * short one-way SHA-256 prefixes over the NFC-sanitized canonical JSON of
 * the payload. The digest identifies a payload (dedup/provenance) without
 * revealing it. The tool NAME is a function identifier (not sensitive) and
 * is kept in clear text, sanitized + length-capped via the shared
 * text-sanitizer.
 *
 * COGNITIVE-TRAP CAVEAT (MemTrap): a stored past path can misfire on a
 * surface-similar new task (Cognitive-Bias / Trauma fixation), MORE so
 * than a bare advice string. Enabling trajectory serving must ride the
 * §4.3 lens-suppression governor + the verifier answer-integrity arm; the
 * structural containment here is that the render below feeds the GENERATOR
 * advisory section only — see strategy-memory.service.renderStrategyNote.
 */

/**
 * Digest length (hex chars) — enough to identify a payload, reveals
 * nothing. The digest itself lives in src/common/payload-digest.ts
 * (extracted so the tool-observation recorder shares the IDIOM without
 * touching this advice surface) and is re-exported below unchanged.
 */
export const TRAJECTORY_DIGEST_LEN = PAYLOAD_DIGEST_LEN;

export { digestPayload };

/** Tool-name clear-text cap (a function identifier, not free text). */
export const TRAJECTORY_TOOL_CAP = 80;

/** Hard bound on stored steps per trajectory (keeps the row + prompt small). */
export const TRAJECTORY_MAX_STEPS = 32;

export type VerifiedOutcome = 'success' | 'failure' | 'unknown';

export const VERIFIED_OUTCOMES: readonly VerifiedOutcome[] = ['success', 'failure', 'unknown'];

export function isVerifiedOutcome(v: unknown): v is VerifiedOutcome {
  return typeof v === 'string' && (VERIFIED_OUTCOMES as readonly string[]).includes(v);
}

/** Stored, sanitized tool step: clear-text tool name + payload digests + ok. */
export interface ToolStep {
  tool: string;
  argsDigest: string;
  resultDigest: string;
  ok: boolean;
}

/** Raw capture-time step from a consumer (args/result may be anything). */
export interface RawToolStep {
  tool: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
}

/** The verified experience captured alongside the distilled strategy item. */
export interface TrajectoryBundle {
  trajectory: ToolStep[];
  verifiedOutcome: VerifiedOutcome;
  outcomeEvidenceRef?: string | undefined;
}

/** Redact a raw capture step into the stored, digest-only ToolStep. */
export function toToolStep(raw: RawToolStep): ToolStep {
  return {
    tool: sanitizePackText(raw.tool, TRAJECTORY_TOOL_CAP),
    argsDigest: digestPayload(raw.args),
    resultDigest: digestPayload(raw.result),
    ok: raw.ok === true,
  };
}

/** Redact + cap a list of raw steps into the stored trajectory. */
export function toTrajectory(steps: RawToolStep[]): ToolStep[] {
  return steps.slice(0, TRAJECTORY_MAX_STEPS).map(toToolStep);
}

/**
 * Advisory render of a trajectory for the GENERATOR's fenced strategy
 * note (never the verifier). Compact past-path summary — tool sequence
 * with per-step ok/fail and the verified outcome. The opaque payload
 * digests are STORAGE-only provenance (dedup / audit); surfacing 16-hex
 * hashes in the prompt would be noise, so they are deliberately not
 * rendered. Empty trajectory ⇒ '' (byte-identical to a note without one).
 */
export function renderTrajectorySuffix(item: {
  trajectory?: ToolStep[] | undefined;
  verifiedOutcome?: VerifiedOutcome | undefined;
}): string {
  const steps = item.trajectory;
  if (!steps || steps.length === 0) return '';
  const path = steps.map((s) => `${s.tool}(${s.ok ? 'ok' : 'fail'})`).join(' → ');
  const outcome = item.verifiedOutcome ? `, verified ${item.verifiedOutcome}` : '';
  return ` [past tool path: ${path}${outcome}]`;
}
