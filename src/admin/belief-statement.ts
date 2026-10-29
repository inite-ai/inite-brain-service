import { sceneBeliefNegationDeltasEnabled } from '../common/scene-flags';

/** Belts against runaway payloads (the enricher's cap discipline). */
export const STATEMENT_MAX_CHARS = 500;

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

/** What one belief statement prompt reads. */
export interface BeliefStatementInput {
  subject: string;
  field: string;
  value: string;
  priorValue: string;
}

/**
 * The one belief phrasing prompt — the server model's and, in harness
 * mode, the connected agent's (belief-statement-work.service.ts).
 */
export function beliefStatementRequest(belief: BeliefStatementInput): {
  system: string;
  user: string;
} {
  // #135 seam 1: the negation clause joins the system prompt only when
  // the flag is on AND the write involves the sentinel (split-constant
  // idiom — flag off, or a non-negation belief, is byte-identical).
  const system =
    sceneBeliefNegationDeltasEnabled() &&
    (belief.value === BELIEF_NEGATION_VALUE || belief.priorValue === BELIEF_NEGATION_VALUE)
      ? BELIEF_SYNTHESIS_SYSTEM + BELIEF_SYNTHESIS_NEGATION_CLAUSE
      : BELIEF_SYNTHESIS_SYSTEM;
  const user =
    `subject: ${belief.subject}\nattribute: ${belief.field}\nvalue: ${belief.value}` +
    (belief.priorValue !== '' && belief.priorValue !== belief.value
      ? `\nprevious value: ${belief.priorValue}`
      : '');
  return { system, user };
}

/** A phrased statement as stored, or null when there is nothing usable. */
export function cleanBeliefStatement(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text.slice(0, STATEMENT_MAX_CHARS);
}
