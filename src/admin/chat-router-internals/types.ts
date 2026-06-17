/**
 * Chat-router type surface. Public route output (ChatRoute) and
 * server-internal raw shapes (RawRouteOutput) live here so the
 * orchestrator, prompts, local-prepass, and validator modules can all
 * reference them without circular imports.
 */

/** Character-offset span pointing into the original user message. */
export interface Span {
  /** Verbatim text at [start, end). Survives NFC normalization round-trip. */
  text: string;
  /** Inclusive UTF-16 code-unit offset into the original message. */
  start: number;
  /** Exclusive UTF-16 code-unit offset. */
  end: number;
}

/**
 * Structured edit operations the LLM emits. The server applies them
 * deterministically to the original message — the LLM never emits the
 * rewritten message itself, so the "silently drops a clause" failure
 * mode is impossible by construction.
 */
export type EditOp =
  | {
      op: 'canonicalize_mention';
      sourceSpan: Span;
      canonical: string;
    }
  | {
      op: 'collapse_state_change';
      sourceSpan: Span;
      replacement: string;
    }
  | {
      op: 'strip_temporal';
      sourceSpan: Span;
    };

export interface TemporalAnchor {
  iso: string;
  anchorSpan: Span;
}

export interface ChatRoute {
  intent: 'tell' | 'ask';
  normalizedMessage: string;
  cleanedQuery?: string;
  mentions: Array<{ canonical: string; span: Span }>;
  predicateHints: Array<{ predicateId: string; triggerSpan: Span }>;
  asOf?: TemporalAnchor;
  validFrom?: TemporalAnchor;
  reason?: string;
}

export interface ValidationReport {
  acceptedEdits: number;
  droppedEdits: Array<{ op: string; reason: string; span?: Span }>;
  acceptedMentions: number;
  droppedMentions: Array<{ canonical?: string; reason: string; span?: Span }>;
  acceptedHints: number;
  droppedHints: Array<{ predicateId?: string; reason: string; span?: Span }>;
  asOfStatus: 'grounded' | 'ungrounded' | 'absent';
  validFromStatus: 'grounded' | 'ungrounded' | 'absent';
}

export const ASK_INTENT_VOCAB = ['tell', 'ask'] as const;

export interface RawSpan {
  text: string;
  start: number;
  end: number;
}

export interface RawRouteOutput {
  intent: 'tell' | 'ask';
  mentions?: Array<{ canonical: string | null; nameSpan: RawSpan }>;
  predicateHints?: Array<{ predicateId: string; triggerSpan: RawSpan }>;
  edits?: Array<{
    op: 'canonicalize_mention' | 'collapse_state_change' | 'strip_temporal';
    sourceSpan: RawSpan;
    canonical: string | null;
    replacement: string | null;
  }>;
  asOf: { iso: string; anchorSpan: RawSpan } | null;
  validFrom: { iso: string; anchorSpan: RawSpan } | null;
  reason: string | null;
}
