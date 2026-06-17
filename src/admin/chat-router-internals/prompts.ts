import { ASK_INTENT_VOCAB } from './types';

/**
 * Build the strict-mode system prompt that frames every routing call.
 * Pure string assembly — keeps the orchestrator out of the prompt
 * authoring weeds. The grounding rules live here so a prompt change
 * doesn't require touching the orchestrator.
 */
export function buildSystemPrompt(
  predicateVocab: string[],
  knownNames: string[],
): string {
  return `You route a free-form chat message to a knowledge-graph backend.

THE GROUNDING RULE (most important):
  Every field you return that points into the user's message — every span
  (mentions, predicate-hint triggers, edit source-spans, temporal anchors)
  — MUST be a VERBATIM substring of the message. Each span is an object
  { "text": "...", "start": N, "end": N } where text equals
  message.slice(start, end) character-for-character. The server validates
  every span and DROPS any field whose span doesn't ground.

  If you cannot quote the words of the input that warrant a slot, return
  null / empty for that slot. Do NOT default. Do NOT paraphrase. Do NOT
  rewrite the message into a free-text string anywhere in your output —
  rewrites are expressed as structured edit operations applied
  deterministically by the server.

OUTPUT CONTRACT (strict JSON schema enforces shape):

  intent: "tell" | "ask"
    tell  = the user is asserting a fact (declarative).
    ask   = the user is asking a question (interrogative or imperative search).

  mentions[]: entities the message names that match a known canonical name.
    { canonical: <one of knownNames>, nameSpan: <Span pointing at the short
                                                  reference in the input> }
    Use this for "Maria" → "Maria Petrov" (when Maria Petrov is in knownNames).
    canonical=null when the entity isn't in knownNames — the server drops
    those.

  predicateHints[] (ask only — empty array on tell): closed-vocab predicates
    the question targets, each with the trigger phrase from the input.
      { predicateId: <one of registered predicates>,
        triggerSpan: <Span at "where lives", "what does X eat", etc.> }
    Common mappings:
      "where lives", "address", "лицо живёт", "где живёт"   → predicate: address
      "what eats", "preference", "что предпочитает"          → predicate: preference
      "what role", "is X the ...", "должность"               → predicate: status
      "what plans to", "wants to"                            → predicate: intent
      "email of"                                             → predicate: email

  edits[]: structured edit operations that the SERVER applies to the input
    message to produce the rewritten form. The model NEVER emits the rewritten
    string itself — only the edit ops.

    The server SYNTHESISES canonicalize_mention (1:1 from accepted mentions)
    and strip_temporal (1:1 from grounded temporal anchors) — do NOT emit
    them. Emit only:

      collapse_state_change: replace a change-of-state verb phrase with the
        present-tense resulting-state form. TENSE-AGNOSTIC — covers past,
        present, future.
        Examples: "switched to keto" → replacement "now prefers keto"
                  "moves to Dublin"  → replacement "lives in Dublin"
                  "joined as CTO"    → replacement "is the CTO"
                  "moved from Berlin"→ replacement "lives in Berlin"

    Apply edits ONLY when they are warranted by the input. Do not invent
    edits to make the message "cleaner" — every edit must point at a real
    substring AND have a clear purpose. Overlapping edits are dropped by
    the server.

  asOf (ask only, optional): { iso: <ISO 8601 relative to "now">,
                               anchorSpan: <Span at the temporal phrase> }
    Emit ONLY when the ask carries an explicit temporal anchor ("yesterday",
    "next month", "вчера", "in March"). NO ANCHOR → set asOf to null.
    Do NOT default to today or now.

  validFrom (tell only, optional): same shape as asOf.
    Emit when a tell carries an anchor for WHEN the fact became true
    ("switched to keto LAST MONTH", "next month moves to Dublin"). NO
    ANCHOR → null. Bare "now" is null.

  reason (optional): one-sentence rationale for the trace.

KNOWN CANONICAL NAMES in the graph:
${JSON.stringify(knownNames)}

REGISTERED PREDICATES in the vocabulary:
${JSON.stringify(predicateVocab)}
`;
}

/**
 * Build the OpenAI strict-mode JSON schema that matches the system
 * prompt's contract. Predicate enum is parameterized — closed vocab
 * when the registry returns predicates, free string when registry
 * lookup failed (permissive fallback).
 */
export function buildSchema(predicateVocab: string[]): Record<string, unknown> {
  const spanSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      start: { type: 'integer', minimum: 0 },
      end: { type: 'integer', minimum: 0 },
    },
    required: ['text', 'start', 'end'],
  };
  const predicateField =
    predicateVocab.length > 0
      ? { type: 'string', enum: predicateVocab }
      : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...ASK_INTENT_VOCAB] },
      mentions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            canonical: { type: ['string', 'null'] },
            nameSpan: spanSchema,
          },
          required: ['canonical', 'nameSpan'],
        },
      },
      predicateHints: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            predicateId: predicateField,
            triggerSpan: spanSchema,
          },
          required: ['predicateId', 'triggerSpan'],
        },
      },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // canonicalize_mention is server-synthesised 1:1 from
            // accepted mentions[]. strip_temporal is server-derived
            // from grounded asOf/validFrom anchors. LLM only owns
            // collapse_state_change.
            op: { type: 'string', enum: ['collapse_state_change'] },
            sourceSpan: spanSchema,
            canonical: { type: ['string', 'null'] },
            replacement: { type: ['string', 'null'] },
          },
          required: ['op', 'sourceSpan', 'canonical', 'replacement'],
        },
      },
      asOf: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              iso: { type: 'string' },
              anchorSpan: spanSchema,
            },
            required: ['iso', 'anchorSpan'],
          },
        ],
      },
      validFrom: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              iso: { type: 'string' },
              anchorSpan: spanSchema,
            },
            required: ['iso', 'anchorSpan'],
          },
        ],
      },
      reason: { type: ['string', 'null'] },
    },
    required: [
      'intent',
      'mentions',
      'predicateHints',
      'edits',
      'asOf',
      'validFrom',
      'reason',
    ],
  };
}
