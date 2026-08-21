/**
 * Wire contract of GET /v1/users/:userId/profile (rolling user profile
 * v1 — deterministic query-time assembly, no LLM calls). Consumers
 * paste `profileText` straight into prompts; `sections` is the same
 * content structured for programmatic use.
 */

/** Per-aspect fact cap — a profile line-item budget, not a recall knob. */
export const PER_ASPECT_CAP = 5;
/** Default global fact budget when the caller omits ?maxFacts=. */
export const DEFAULT_MAX_FACTS = 60;
/** Hard ceiling on ?maxFacts= — beyond this a profile stops being one. */
export const HARD_MAX_FACTS = 200;

export interface ProfileFactWire {
  factId: string;
  /** The fact's object verbatim — deterministic v1 renders, never rewrites. */
  statement: string;
  /** ISO instant the fact became valid (bitemporal validity axis). */
  validFrom: string;
  confidence: number;
  /** Last independent corroboration (`corroboration.lastAt`), when any. */
  lastSeenAt?: string;
  /** Typed-atom kind (`source.kind`, DERIVER_TYPED_ATOMS), when stamped. */
  kind?: string;
}

export interface ProfileSectionWire {
  /** The grouping key: the fact predicate — an aspect slug in derived
   *  worlds (identity, work, …), a vocabulary predicate for ingested
   *  facts (lives_in, …). */
  aspect: string;
  facts: ProfileFactWire[];
}

export interface UserProfileWire {
  userId: string;
  generatedAt: string;
  /** Facts included after the per-aspect and global caps. */
  factCount: number;
  sections: ProfileSectionWire[];
  /** One line per fact: `- [aspect] statement (as of YYYY-MM-DD)`. */
  profileText: string;
}
