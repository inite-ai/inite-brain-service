import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { PredicateRegistryService } from '../ai/predicate-registry.service';

/**
 * Grounded chat router for the brain demo.
 *
 * Architectural rule of this service: every output field that drives
 * downstream behaviour MUST be grounded in the user message via deterministic
 * server-side validation. The LLM never emits a free-text rewrite or a
 * "default" timestamp — instead it returns STRUCTURED EDIT OPERATIONS and
 * SPAN-ANCHORED slots, all of which the server validates by checking that
 * the claimed substring actually appears in the input.
 *
 * The pattern follows 2025-26 SOTA practice for grounded LLM routers /
 * extractors:
 *   • LangExtract (Google) — character-offset spans + fuzzy alignment
 *   • Anthropic Citations API — cited_text + char range validated server-side
 *   • 5IDER / R-Bot — predict EDIT operations, not strings
 *   • EDC / ODKE+ — provenance per transform
 *   • PARSE (arXiv:2510.08623) — offline schema iteration, not online retry
 *
 * Output contract:
 *   intent          — closed enum
 *   edits[]         — structured edit script. Server applies in order to
 *                     produce normalizedMessage and cleanedQuery. Killing the
 *                     free-text rewrite is what removes the "silently drops a
 *                     clause" failure mode by construction.
 *   mentions[]      — entities the message names, each with a Span pointing
 *                     into the original message.
 *   predicateHints[]— predicate IDs the question targets, each with a Span
 *                     showing WHICH words in the input warranted the hint.
 *   asOf?           — { iso, anchorSpan } — only kept when the anchor is
 *                     grounded. No anchor → null.
 *   validFrom?      — same shape as asOf.
 *   reason          — free text for trace; never consumed downstream.
 *
 * Server-side validation pipeline (degrade-on-fail per slot, never reject
 * the whole route):
 *   1. JSON parse (strict mode in LLM API)
 *   2. NFC-normalize input + every Span.text
 *   3. Per-Span: input.slice(start,end) === text? If not, attempt repair via
 *      first-substring-match. If still no, drop the field.
 *   4. Vocab filter: predicateHints[].predicateId ∈ registry snapshot;
 *      mentions[].canonical ∈ knownNames or null.
 *   5. Cross-field consistency: intent='tell' ⇒ predicateHints empty +
 *      asOf null; intent='ask' ⇒ validFrom null.
 *   6. Apply edits[] right-to-left to original message → normalizedMessage.
 *      Apply edits[] minus canonicalize → cleanedQuery (ask only).
 *   7. Emit ChatRoute + ValidationReport trace artifact.
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
 * rewritten message itself, so the "silently drops a clause" failure mode
 * is impossible by construction.
 */
export type EditOp =
  | {
      op: 'canonicalize_mention';
      /** Where in the input the short reference appears. */
      sourceSpan: Span;
      /** Replacement canonical name. Must be one of knownNames. */
      canonical: string;
    }
  | {
      op: 'collapse_state_change';
      /** State-change verb phrase that should collapse to its result state. */
      sourceSpan: Span;
      /** Present-tense resulting-state phrase. */
      replacement: string;
    }
  | {
      op: 'strip_temporal';
      /** Temporal anchor span (paired with a corresponding asOf/validFrom). */
      sourceSpan: Span;
    };

export interface TemporalAnchor {
  iso: string;
  anchorSpan: Span;
}

export interface ChatRoute {
  intent: 'tell' | 'ask';
  /** Result of applying validated edits[] to the original message. Always
   *  populated — falls back to the original when no edits applied. */
  normalizedMessage: string;
  /** Ask-only: edits[] minus canonicalize_mention applied. The query for
   *  retrieval — temporal anchor stripped, state-change verbs collapsed,
   *  but entity NAMES untouched so the retrieval lexical match still sees
   *  the user's exact wording. */
  cleanedQuery?: string;
  /** Grounded entity references. canonical is always in knownNames; span
   *  is the substring of input that pointed at the entity. */
  mentions: Array<{ canonical: string; span: Span }>;
  /** Grounded predicate hints. predicateId is always in the registry
   *  snapshot; triggerSpan is the substring that warranted the hint. */
  predicateHints: Array<{ predicateId: string; triggerSpan: Span }>;
  /** Ask-only. Only set when the LLM produced a grounded anchor span. */
  asOf?: TemporalAnchor;
  /** Tell-only. Only set when the LLM produced a grounded anchor span. */
  validFrom?: TemporalAnchor;
  /** Free-text rationale the LLM gave — debug trace only. */
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

const ASK_INTENT_VOCAB = ['tell', 'ask'] as const;

@Injectable()
export class ChatRouterService {
  private readonly logger = new Logger(ChatRouterService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: PredicateRegistryService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: 15_000,
      maxRetries: 1,
    });
    this.model = this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
  }

  async route(
    message: string,
    options: { knownNames?: string[]; now?: Date; companyId: string },
  ): Promise<ChatRoute> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const knownNames = options.knownNames ?? [];
    // Per-tenant predicate vocab for the LLM-side enum constraint.
    // Defensive: registry failure degrades to permissive — the strict-mode
    // enum drops to free string in that case (handled below).
    let snapshot:
      | { versionHash: string; active: { predicateId: string }[] }
      | null = null;
    try {
      snapshot = await this.registry.getSnapshot(options.companyId);
    } catch (e) {
      this.logger.warn(
        `chat router: registry getSnapshot failed for ${options.companyId}: ${(e as Error).message}; falling back to permissive vocab`,
      );
    }
    const predicateVocab =
      snapshot?.active.map((p) => p.predicateId) ?? [];

    const system = buildSystemPrompt(predicateVocab, knownNames);
    const user = `now: ${nowIso}
message: ${message}`;

    return traceSpan('demo.chat.route', async () => {
      traceArtifact('demo.chat.prompt', {
        system,
        user,
        model: this.model,
        registryVersionHash: snapshot?.versionHash ?? 'unavailable',
        predicateCount: predicateVocab.length,
        knownNamesCount: knownNames.length,
      });
      const res = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'chat_route',
            strict: true,
            schema: buildSchema(predicateVocab),
          },
        },
        temperature: 0,
        max_completion_tokens: 800,
      });
      const content = res.choices[0]?.message?.content;
      const finish = res.choices[0]?.finish_reason;
      traceArtifact('demo.chat.raw', { content, finish_reason: finish });
      if (!content) {
        return this.safeDefault(
          message,
          `router-empty (finish=${finish ?? 'unknown'})`,
        );
      }
      let parsed: RawRouteOutput;
      try {
        parsed = JSON.parse(extractJsonObject(content)) as RawRouteOutput;
      } catch (e) {
        this.logger.warn(
          `chat router parse failed: ${(e as Error).message}; raw="${content.slice(0, 200)}"`,
        );
        return this.safeDefault(message, `router-parse: ${(e as Error).message}`);
      }
      return this.validateAndAssemble(
        message,
        parsed,
        new Set(predicateVocab),
        new Set(knownNames),
      );
    });
  }

  /**
   * Server-side validation pipeline. Each slot degrades independently — a
   * failed asOf becomes absent, a failed mention is dropped, a failed edit
   * is skipped. The route ALWAYS returns SOMETHING; downstream never 500s
   * on a partial validation failure.
   */
  private validateAndAssemble(
    message: string,
    parsed: RawRouteOutput,
    vocab: Set<string>,
    knownNames: Set<string>,
  ): ChatRoute {
    const normalizedInput = nfc(message);
    const report: ValidationReport = {
      acceptedEdits: 0,
      droppedEdits: [],
      acceptedMentions: 0,
      droppedMentions: [],
      acceptedHints: 0,
      droppedHints: [],
      asOfStatus: 'absent',
      validFromStatus: 'absent',
    };

    // 1. Mentions — every mention's nameSpan must ground; canonical must
    //    be in knownNames (or null = unrecognised entity, dropped).
    const mentions: Array<{ canonical: string; span: Span }> = [];
    for (const m of parsed.mentions ?? []) {
      const span = validateSpan(message, normalizedInput, m.nameSpan);
      if (!span) {
        report.droppedMentions.push({
          canonical: m.canonical ?? undefined,
          reason: 'ungrounded',
          span: m.nameSpan,
        });
        continue;
      }
      if (!m.canonical || !knownNames.has(m.canonical)) {
        report.droppedMentions.push({
          canonical: m.canonical ?? undefined,
          reason: 'not_in_known_names',
          span,
        });
        continue;
      }
      mentions.push({ canonical: m.canonical, span });
      report.acceptedMentions++;
    }

    // 2. Predicate hints — triggerSpan grounds + predicateId ∈ vocab.
    const predicateHints: Array<{ predicateId: string; triggerSpan: Span }> = [];
    if (parsed.intent === 'ask') {
      for (const h of parsed.predicateHints ?? []) {
        const span = validateSpan(message, normalizedInput, h.triggerSpan);
        if (!span) {
          report.droppedHints.push({
            predicateId: h.predicateId,
            reason: 'ungrounded',
            span: h.triggerSpan,
          });
          continue;
        }
        if (vocab.size > 0 && !vocab.has(h.predicateId)) {
          report.droppedHints.push({
            predicateId: h.predicateId,
            reason: 'not_in_vocab',
            span,
          });
          continue;
        }
        predicateHints.push({
          predicateId: h.predicateId,
          triggerSpan: span,
        });
        report.acceptedHints++;
      }
    }

    // 3. Temporal anchors — both asOf and validFrom must have a grounded
    //    anchor span AND a valid ISO timestamp to survive. Cross-field
    //    consistency: tell carries validFrom only; ask carries asOf only.
    let asOf: TemporalAnchor | undefined;
    if (parsed.intent === 'ask' && parsed.asOf) {
      const span = validateSpan(
        message,
        normalizedInput,
        parsed.asOf.anchorSpan,
      );
      if (span && isValidIso(parsed.asOf.iso)) {
        asOf = { iso: parsed.asOf.iso, anchorSpan: span };
        report.asOfStatus = 'grounded';
      } else {
        report.asOfStatus = 'ungrounded';
      }
    }
    let validFrom: TemporalAnchor | undefined;
    if (parsed.intent === 'tell' && parsed.validFrom) {
      const span = validateSpan(
        message,
        normalizedInput,
        parsed.validFrom.anchorSpan,
      );
      if (span && isValidIso(parsed.validFrom.iso)) {
        validFrom = { iso: parsed.validFrom.iso, anchorSpan: span };
        report.validFromStatus = 'grounded';
      } else {
        report.validFromStatus = 'ungrounded';
      }
    }

    // 4. Edits — each edit's sourceSpan must ground; canonicalize edits
    //    must have canonical ∈ knownNames. Edits whose sourceSpan overlaps
    //    another accepted edit are dropped (right-to-left application
    //    can't handle overlapping ranges cleanly).
    const candidateEdits: Array<{ edit: EditOp; span: Span }> = [];
    for (const e of parsed.edits ?? []) {
      const span = validateSpan(message, normalizedInput, e.sourceSpan);
      if (!span) {
        report.droppedEdits.push({
          op: e.op,
          reason: 'ungrounded',
          span: e.sourceSpan,
        });
        continue;
      }
      if (e.op === 'canonicalize_mention') {
        if (!knownNames.has(e.canonical)) {
          report.droppedEdits.push({
            op: e.op,
            reason: 'canonical_not_in_known_names',
            span,
          });
          continue;
        }
      }
      candidateEdits.push({ edit: { ...e, sourceSpan: span }, span });
    }
    // Drop overlap: keep the first, drop any subsequent edit that overlaps.
    candidateEdits.sort((a, b) => a.span.start - b.span.start);
    const acceptedEdits: typeof candidateEdits = [];
    let lastEnd = -1;
    for (const c of candidateEdits) {
      if (c.span.start < lastEnd) {
        report.droppedEdits.push({
          op: c.edit.op,
          reason: 'overlaps_prior_edit',
          span: c.span,
        });
        continue;
      }
      acceptedEdits.push(c);
      lastEnd = c.span.end;
    }
    report.acceptedEdits = acceptedEdits.length;

    // 5. Auto-derive strip_temporal edits from grounded asOf/validFrom
    //    anchors. The LLM is supposed to emit these explicitly but is
    //    inconsistent — and the rule is mechanical anyway: if we captured
    //    the timestamp from a span, that span should be stripped from
    //    the message that flows downstream. Skip if the anchor would
    //    overlap a prior accepted edit.
    const autoStripEdits: EditOp[] = [];
    for (const anchor of [asOf?.anchorSpan, validFrom?.anchorSpan]) {
      if (!anchor) continue;
      const overlaps = acceptedEdits.some(
        (c) =>
          !(c.span.end <= anchor.start || c.span.start >= anchor.end),
      );
      if (overlaps) continue;
      autoStripEdits.push({ op: 'strip_temporal', sourceSpan: anchor });
    }
    const allEdits = [
      ...acceptedEdits.map((c) => c.edit),
      ...autoStripEdits,
    ];

    // 6. Apply edits right-to-left so earlier offsets stay valid as we
    //    splice. Produces normalizedMessage (all edits) and cleanedQuery
    //    (skip canonicalize_mention so retrieval lexical match keeps the
    //    user's wording).
    const normalizedMessage = applyEdits(message, allEdits, () => true);
    const cleanedQuery =
      parsed.intent === 'ask'
        ? applyEdits(
            message,
            allEdits,
            (op) => op !== 'canonicalize_mention',
          )
        : undefined;

    traceArtifact('demo.chat.validation', report);

    return {
      intent: parsed.intent,
      normalizedMessage,
      ...(cleanedQuery !== undefined && cleanedQuery !== message
        ? { cleanedQuery }
        : {}),
      mentions,
      predicateHints,
      ...(asOf ? { asOf } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  }

  /** Safe default when the LLM gave us nothing usable. Treat as a tell of
   *  the original message — ingest still happens, downstream pipeline
   *  doesn't 500. */
  private safeDefault(message: string, reason: string): ChatRoute {
    this.logger.warn(`chat router defaulting: ${reason}`);
    const fallback: ChatRoute = {
      intent: 'tell',
      normalizedMessage: message,
      mentions: [],
      predicateHints: [],
      reason,
    };
    traceArtifact('demo.chat.route', fallback);
    return fallback;
  }
}

// ── Prompt + schema builders ─────────────────────────────────────────────

function buildSystemPrompt(
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
      canonicalize_mention: replace a short reference with its canonical name.
        sourceSpan = short reference; canonical = canonical name.
        Example: input "Maria switched to keto" → edit
          { op: "canonicalize_mention", sourceSpan: { text: "Maria", start: 0, end: 5 },
            canonical: "Maria Petrov" }
      collapse_state_change: replace a change-of-state verb phrase with the
        present-tense resulting-state form. TENSE-AGNOSTIC — covers past,
        present, future.
        Examples: "switched to keto" → replacement "now prefers keto"
                  "moves to Dublin"  → replacement "lives in Dublin"
                  "joined as CTO"    → replacement "is the CTO"
                  "moved from Berlin"→ replacement "lives in Berlin"
      strip_temporal: remove a temporal anchor phrase (always paired with an
        asOf/validFrom emission so the timestamp is captured separately).
        sourceSpan = the phrase ("next month", "last week", "в марте",
        "since February").

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

function buildSchema(predicateVocab: string[]): Record<string, unknown> {
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
            op: {
              type: 'string',
              enum: [
                'canonicalize_mention',
                'collapse_state_change',
                'strip_temporal',
              ],
            },
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

// ── Validation helpers ──────────────────────────────────────────────────

interface RawSpan {
  text: string;
  start: number;
  end: number;
}

interface RawRouteOutput {
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

/** NFC normalization — keeps the multi-byte cases (Cyrillic combining
 *  marks, EN-vs-RU quotes) from breaking offset arithmetic. */
function nfc(s: string): string {
  return s.normalize('NFC');
}

/**
 * Validate a span against the input. Three levels:
 *   1. Exact: original.slice(start,end) === text
 *   2. NFC-equivalent: nfc(original).slice(start,end) === nfc(text)
 *   3. Repair: find the first occurrence of nfc(text) in nfc(original),
 *      synthesize offsets. Logs but accepts.
 *
 * Returns the validated Span with possibly-repaired offsets, or null if
 * no level matched.
 */
function validateSpan(
  original: string,
  normalizedOriginal: string,
  raw: RawSpan | undefined | null,
): Span | null {
  if (!raw || typeof raw.text !== 'string') return null;
  if (raw.text.trim().length === 0) return null;
  const { text, start, end } = raw;
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= original.length &&
    start < end &&
    original.slice(start, end) === text
  ) {
    return { text, start, end };
  }
  const normalizedText = nfc(text);
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= normalizedOriginal.length &&
    start < end &&
    normalizedOriginal.slice(start, end) === normalizedText
  ) {
    return { text, start, end };
  }
  const idx = normalizedOriginal.indexOf(normalizedText);
  if (idx >= 0) {
    return { text, start: idx, end: idx + normalizedText.length };
  }
  return null;
}

/**
 * Apply edits[] right-to-left so earlier offsets remain valid as we splice.
 * filterOp selects which edits to apply — used to derive cleanedQuery by
 * skipping canonicalize_mention edits.
 */
function applyEdits(
  original: string,
  edits: EditOp[],
  filterOp: (op: EditOp['op']) => boolean,
): string {
  const applicable = edits
    .filter((e) => filterOp(e.op))
    .sort((a, b) => b.sourceSpan.start - a.sourceSpan.start);
  let working = original;
  for (const e of applicable) {
    const { start, end } = e.sourceSpan;
    const replacement =
      e.op === 'canonicalize_mention'
        ? e.canonical
        : e.op === 'collapse_state_change'
          ? e.replacement
          : ''; // strip_temporal
    working =
      working.slice(0, start) + replacement + working.slice(end);
  }
  // Collapse any double-spaces strip_temporal left behind.
  return working.replace(/\s+/g, ' ').trim();
}

function isValidIso(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/**
 * Extracts the first balanced top-level JSON object from a possibly noisy
 * LLM output. Handles leading sentinel tokens, markdown code fences,
 * trailing prose.
 */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inner = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const start = inner.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in router response');
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < inner.length; i++) {
    const c = inner[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return inner.slice(start, i + 1);
    }
  }
  throw new Error('unterminated JSON object in router response');
}
