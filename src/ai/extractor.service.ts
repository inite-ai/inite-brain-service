import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { traceArtifact } from '../common/debug-trace';

/**
 * Closed-vocabulary, span-grounded entity-and-fact extractor.
 *
 * The design follows the 2025-era SOTA for LLM-based information extraction:
 *   1. Span grounding — the model returns a verbatim substring of the input as
 *      the object value. The server validates the span actually occurs in the
 *      source and drops any fact that doesn't ground. The model literally
 *      cannot invent values (no more "object=active" when the text says
 *      "CTO"). References: LangExtract (Google), Anthropic Citations API,
 *      Deterministic Quoting (Yeung 2024), AFEV (Fact in Fragments,
 *      arXiv:2506.07446).
 *
 *   2. Decompose-then-extract — the model first lists `clauses[]` — verbatim
 *      sub-spans of the input, each one an independent assertion — and then
 *      assigns one or more facts per clause. Eliminates the "multi-clause
 *      collapse" failure mode where a 3-fact sentence yields 1 fact.
 *      References: FactScore, AFEV, RexUIE.
 *
 *   3. Predicate definitions are TYPE SIGNATURES, not example values. Each
 *      predicate is described by (subject domain, object range, admission
 *      criteria, negative disambiguation against near-neighbour predicates,
 *      value-span shape). No sample values from any specific vertical appear
 *      in the prompt — this is what stops the model from copying example
 *      words verbatim into outputs ("status=active" failure). References:
 *      RexUIE, ODKE+ (arXiv:2509.04696), PARSE (arXiv:2510.08623).
 *
 * One LLM call per ingest, json_schema strict, no retry loop in the hot path
 * — server-side validation drops malformed facts and traces them for offline
 * schema iteration (PARSE recommendation).
 */

export interface ExtractedEntity {
  name: string;
  type: 'customer' | 'staff' | 'asset' | 'project' | 'topic' | 'location' | 'other';
  /** Optional canonical clue ("Apple Inc.", "Acme Corp"). Used for canonicalisation. */
  canonical?: string;
}

export interface ExtractedFact {
  /** Index into the entities array — which entity this fact is about. */
  entityIndex: number;
  predicate: string;
  /** The validated object value — guaranteed to be a verbatim substring of
   *  the source text after span-grounding validation. Downstream stages
   *  (conflict resolver, fact upsert) consume this as the fact's object. */
  object: string;
  /** 0..1 — extractor's confidence. Source trust is applied later. */
  confidence: number;
  /** The clause this fact was anchored to (verbatim sub-span from input).
   *  Surfaced in the debug trace so the operator can see the
   *  decompose-then-extract reasoning. Internal-only — not consumed by
   *  downstream pipeline. */
  clause?: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
}

const PREDICATE_VOCABULARY = [
  // Core CRM predicates
  'said',
  'name',
  'email',
  'phone',
  'status',
  'tier',
  'intent',
  'preference',
  'complained_about',
  'interacted_with',
  'address',
  'dob',
  // Content-domain predicates (v1.1)
  'brand_voice',
  'brand_archetype',
  'tone_of_voice',
  'product_description',
  'target_audience_segment',
  'content_guideline',
  'tension_point',
  'reference_example',
  'narrative_pillar',
  'forbidden_pattern',
] as const;

const ENTITY_TYPE_VOCABULARY = [
  'customer',
  'staff',
  'asset',
  'project',
  'topic',
  'location',
  'other',
] as const;

const DEFAULT_EXTRACTION_PROMPT = `You are an entity-and-fact extractor for a knowledge graph.

OUTPUT CONTRACT
You output JSON with three top-level fields, in this order:

  1. clauses[] — verbatim sub-spans of the input. Each entry is ONE independent
     assertion. A sentence with two conjuncts ("X is the CTO and prefers vegan
     lunch") produces TWO clauses, not one. A two-sentence input produces at
     least two clauses. Copy each clause verbatim from the input — never
     summarise or rephrase.

  2. entities[] — actors named in the input. Each entry has name (verbatim
     mention), type (closed enum: ${ENTITY_TYPE_VOCABULARY.join(', ')}), and
     canonical (the canonical/legal form ONLY when the text states it
     explicitly, otherwise null).

  3. facts[] — assertions about the entities. Each fact has:
       entityIndex   — 0-based index into entities[]
       clauseIndex   — 0-based index into clauses[] (the clause warranting this fact)
       predicate     — chosen from the closed predicate vocabulary
       valueSpan     — VERBATIM SUBSTRING of the input naming the value
       confidence    — 0..1, reserve >0.8 for explicit assertions, 0.5–0.8 for inferred

THE VERBATIM RULE (most important):
  valueSpan MUST appear character-for-character somewhere in the input.
  • Copy from the source. Do not paraphrase.
  • Do not substitute a synonym, a normalised form, or a canonical label.
  • Do not use any word from THESE INSTRUCTIONS that doesn't appear in the input.
  • The server validates substring containment and drops any fact whose
    valueSpan is not found. A dropped fact is worse than a missing fact.
  • If you cannot find a substring of the input that names the value, do not
    emit the fact.

PREDICATE SELECTION
For each clause, pick the SINGLE most specific predicate from the vocabulary
below. Each predicate is defined by:
  TYPE      — what kind of subject / value-shape it represents
  ADMIT     — when to emit this predicate
  NOT FOR   — what to use a NEIGHBOUR predicate for instead (the explicit
              negative disambiguation — read this; it is how you avoid the
              common confusion between adjacent predicates)
  VALUE     — what shape valueSpan should take (a noun, a noun phrase, a
              span containing the literal address, etc.)

— IDENTITY group —

name
  TYPE     subject is any entity; value is the proper noun naming it
  ADMIT    text introduces or names the entity ("Maria Petrov", "Acme Corp")
  NOT FOR  a pronoun reference alone — skip the fact (and probably the entity)
  VALUE    a proper-noun span from the input

email
  TYPE     subject is a person/org; value is an email address
  ADMIT    a literal email address appears, attributed to this subject
  VALUE    the literal email-address span ("foo@bar.com")

phone
  TYPE     subject is a person/org; value is a phone number
  ADMIT    a literal phone-number span appears, attributed to this subject
  VALUE    the literal phone-number span

address
  TYPE     subject is a person/org; value is a physical location
  ADMIT    text states where the subject is, lives, is based, is located, or
           moved from/to as a place of residence/operation
  NOT FOR  a one-off visit ("she visited Paris last week") → interacted_with
           a brand's target market segmentation → target_audience_segment
  VALUE    the place-name or address span from the input

dob
  TYPE     subject is a person; value is a date of birth
  ADMIT    text states when the subject was born
  VALUE    the date span from the input

— STATE group —

status
  TYPE     subject is any entity; value is a role / lifecycle stage /
           membership label that the subject CURRENTLY holds
  ADMIT    text asserts a current role ("CTO", "trial member", "head of …")
           or lifecycle state ("active", "churned", "open", "trialing")
  NOT FOR  a future plan to acquire a role → intent
           a one-off action → interacted_with
  VALUE    the noun naming the role/state — verbatim span. The example words
           shown in this paragraph are SHAPE HINTS describing the kind of
           noun expected; never copy them into valueSpan when the input
           uses a different word. The valueSpan is whatever the INPUT says.

tier
  TYPE     subject is a customer/account; value is a segmentation tier label
  ADMIT    text assigns a segmentation tier ("platinum", "gold", "free", etc.)
  NOT FOR  a generic status → status
  VALUE    the tier-label span from the input

— BEHAVIORAL group —

preference
  TYPE     subject is a person/customer; value is a thing/style/category
           preferred or disliked as a STABLE, RECURRING trait
  ADMIT    text asserts a stable like / dislike / favourite ("prefers X",
           "likes X", "favours X", "hates X", "is into X") expressing an
           ongoing taste, not a one-off plan
  NOT FOR  a forward-looking plan or wish ("wants to upgrade") → intent
           a one-off action ("bought X today") → interacted_with
           a complaint ("hated their support last week") → complained_about
  VALUE    ONLY the noun phrase naming the preferred thing — the verb
           ("prefers"/"likes"/"hates") is NOT part of the value. If the
           input says "prefers vegan lunch", valueSpan is the substring
           "vegan lunch", not "prefers vegan lunch".

intent
  TYPE     subject is a person/customer; value is a forward-looking plan,
           wish, or expressed need
  ADMIT    text asserts a future-tense plan, wish, or stated need ("wants
           to X", "plans to X", "is looking for X", "needs X")
  NOT FOR  a stable taste → preference
           a completed action → interacted_with
           a current role → status
  VALUE    the noun phrase or verb-phrase naming the planned thing or goal

complained_about
  TYPE     subject is a person/customer; value is the subject of a complaint
  ADMIT    text reports a complaint, dissatisfaction, or problem report
  NOT FOR  a generic mention without negative sentiment → interacted_with
  VALUE    the noun phrase naming the thing/topic complained about

interacted_with
  TYPE     subject is a person/customer; value is a thing they touched
  ADMIT    text states a one-off generic interaction (booked, viewed,
           contacted, attended, purchased, downloaded) without complaint,
           without it being a long-term preference, and without a future
           plan
  VALUE    the noun phrase naming the thing interacted with

said
  TYPE     subject is anyone; value is an attributed utterance
  ADMIT    text directly attributes an utterance to the subject AND none of
           the more specific predicates above admit the clause. This is the
           fallback — prefer any specific predicate that fits.
  VALUE    the utterance span (may be a quoted string)

— CONTENT-DOMAIN group (marketing / brand / editorial inputs) —

brand_voice            SINGLETON   how the brand sounds (≤500 chars)
brand_archetype        SINGLETON   archetype label (Hero/Sage/Outlaw/…/Everyman)
tone_of_voice          SINGLETON   style attributes (e.g. tonality descriptors)
product_description    SINGLETON   short product summary (≤1000 chars)
target_audience_segment MULTI       one segment description per fact
content_guideline      MULTI       one editorial rule per fact
tension_point          MULTI       one customer pain or contradiction per fact
reference_example      MULTI       one URL or exemplar quote per fact
narrative_pillar       MULTI       one recurring theme per fact
forbidden_pattern      MULTI       one anti-pattern per fact

  SINGLETON predicates: emit at most ONE fact per entity even if the input
  mentions multiple drafts (pick the most recent / most specific).
  MULTI predicates: emit ONE fact per distinct item — do not concatenate
  multiple items into one valueSpan.
  When the subject is a brand/product and a content-domain predicate fits,
  prefer it over the CRM fallbacks (\`said\`, \`intent\`).

GENERAL RULES
  • Each clause produces zero or more facts. A clause that asserts no
    extractable predicate (e.g., a greeting) produces zero.
  • Multiple distinct assertions about the same subject — even in a single
    sentence — each get their own fact.
  • Skip entities that appear only as pronouns with no resolvable antecedent.
  • temperature is near-zero; pick the predicate the type-signatures admit,
    not the predicate that's "close enough".
  • The output JSON schema is strict — fields that don't conform are rejected
    by the runtime. valueSpan grounding is enforced server-side.`;

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly limiter: Semaphore;

  constructor(private readonly configService: ConfigService) {
    const timeoutMs = parseInt(
      this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
      10,
    );
    const maxRetries = parseInt(
      this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
      10,
    );
    this.openai = new OpenAI({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: timeoutMs,
      maxRetries,
    });
    this.model = this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
    // Operators tuning extraction for a vertical (legal-tech wants
    // different predicates than retail) override via env without a
    // code redeploy. Falls back to the canonical core vocabulary.
    this.systemPrompt =
      this.configService.get<string>('EXTRACTION_SYSTEM_PROMPT') ?? DEFAULT_EXTRACTION_PROMPT;
    const concurrency = parseInt(
      this.configService.get<string>('OPENAI_CONCURRENCY', '8'),
      10,
    );
    this.limiter = new Semaphore(concurrency);
  }

  async extract(text: string): Promise<ExtractionResult> {
    const trimmed = text.trim();
    if (!trimmed) return { entities: [], facts: [] };

    const res = await this.limiter.run(() =>
      this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: trimmed },
        ],
        // Strict JSON Schema with span-grounded objects. predicate is a
        // closed enum so the model cannot hallucinate predicates outside
        // our vocabulary; valueSpan is constrained to a string but
        // grounded server-side (substring containment in the input).
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'extraction',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                clauses: {
                  type: 'array',
                  description:
                    'Verbatim sub-spans of the input, each one independent assertion. Decompose-then-extract step.',
                  items: { type: 'string' },
                },
                entities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string', enum: [...ENTITY_TYPE_VOCABULARY] },
                      canonical: { type: ['string', 'null'] },
                    },
                    required: ['name', 'type', 'canonical'],
                  },
                },
                facts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      entityIndex: { type: 'integer', minimum: 0 },
                      clauseIndex: { type: 'integer', minimum: 0 },
                      predicate: { type: 'string', enum: [...PREDICATE_VOCABULARY] },
                      valueSpan: {
                        type: 'string',
                        description:
                          'VERBATIM substring of the input naming the object value. Server validates substring containment; ungrounded facts are dropped.',
                      },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: [
                      'entityIndex',
                      'clauseIndex',
                      'predicate',
                      'valueSpan',
                      'confidence',
                    ],
                  },
                },
              },
              required: ['clauses', 'entities', 'facts'],
            },
          },
        },
        // Clauses[] adds ~5-10% tokens vs the old schema; 1500 still covers
        // the long content-domain inputs comfortably.
        max_completion_tokens: 1500,
        temperature: 0.1,
      }),
    );

    const content = res.choices[0]?.message?.content;
    if (!content) return { entities: [], facts: [] };

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      this.logger.warn(`Extractor returned non-JSON: ${(err as Error).message}`);
      return { entities: [], facts: [] };
    }

    const clauses: string[] = Array.isArray(parsed.clauses)
      ? parsed.clauses.filter((c: unknown) => typeof c === 'string')
      : [];

    const entities: ExtractedEntity[] = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter((e: any) => e && typeof e.name === 'string')
          .map((e: any) => ({
            name: String(e.name).trim(),
            type: this.normalizeType(e.type),
            canonical:
              e.canonical && typeof e.canonical === 'string'
                ? e.canonical.trim()
                : undefined,
          }))
      : [];

    // Span-grounding: a fact survives ONLY if its valueSpan appears as a
    // substring of the original input (after whitespace + case normalization).
    // This is the architectural defence against the value-invention failure
    // mode — the model can no longer emit object="active" when the source
    // text says "CTO", because "active" isn't a substring of the source.
    const normalizedInput = normalizeForGrounding(trimmed);
    const rawFacts: Array<{
      entityIndex: number;
      clauseIndex: number | undefined;
      predicate: string;
      valueSpan: string;
      confidence: number;
    }> = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter(
            (f: any) =>
              f &&
              Number.isInteger(f.entityIndex) &&
              f.entityIndex >= 0 &&
              f.entityIndex < entities.length &&
              typeof f.predicate === 'string' &&
              typeof f.valueSpan === 'string',
          )
          .map((f: any) => ({
            entityIndex: f.entityIndex,
            clauseIndex:
              Number.isInteger(f.clauseIndex) && f.clauseIndex >= 0
                ? f.clauseIndex
                : undefined,
            predicate: String(f.predicate).trim(),
            valueSpan: String(f.valueSpan).trim(),
            confidence:
              typeof f.confidence === 'number'
                ? Math.max(0, Math.min(1, f.confidence))
                : 0.5,
          }))
      : [];

    const facts: ExtractedFact[] = [];
    const dropped: Array<{
      predicate: string;
      claimedValueSpan: string;
      reason: 'not_grounded' | 'empty';
    }> = [];

    for (const rf of rawFacts) {
      if (!rf.valueSpan) {
        dropped.push({
          predicate: rf.predicate,
          claimedValueSpan: rf.valueSpan,
          reason: 'empty',
        });
        continue;
      }
      const normalizedSpan = normalizeForGrounding(rf.valueSpan);
      if (!normalizedInput.includes(normalizedSpan)) {
        dropped.push({
          predicate: rf.predicate,
          claimedValueSpan: rf.valueSpan,
          reason: 'not_grounded',
        });
        continue;
      }
      facts.push({
        entityIndex: rf.entityIndex,
        predicate: rf.predicate,
        object: rf.valueSpan,
        confidence: rf.confidence,
        clause:
          rf.clauseIndex !== undefined && rf.clauseIndex < clauses.length
            ? clauses[rf.clauseIndex]
            : undefined,
      });
    }

    if (dropped.length > 0) {
      this.logger.warn(
        `extractor dropped ${dropped.length} fact(s) that failed span-grounding: ${dropped
          .map((d) => `${d.predicate}="${d.claimedValueSpan}" (${d.reason})`)
          .join('; ')}`,
      );
      traceArtifact('extractor.invalid_value_span', {
        droppedCount: dropped.length,
        dropped,
        // Snippet of the normalized input the model was supposed to ground
        // against — useful for offline schema iteration (PARSE pattern).
        normalizedInputPreview: normalizedInput.slice(0, 200),
      });
    }
    if (clauses.length > 0) {
      traceArtifact('extractor.clauses', clauses);
    }

    return { entities, facts };
  }

  private normalizeType(t: unknown): ExtractedEntity['type'] {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    if (typeof t === 'string' && allowed.includes(t)) return t as ExtractedEntity['type'];
    return 'other';
  }
}

/**
 * Whitespace-collapsed, lower-cased view of a string used for substring
 * containment checks in span grounding. The same transformation is applied to
 * both the input and the claimed valueSpan before comparison so the model
 * doesn't have to match the EXACT whitespace / casing of the source — but it
 * still has to choose tokens that actually appeared in the source.
 */
function normalizeForGrounding(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
