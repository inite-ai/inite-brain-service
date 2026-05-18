import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';

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
  object: string;
  /** 0..1 — extractor's confidence. Source trust is applied later. */
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
}

const PREDICATE_VOCABULARY = [
  // CRM predicates (unchanged)
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

const DEFAULT_EXTRACTION_PROMPT = `You are an entity and fact extractor for a multi-vertical SaaS knowledge graph.

Given a piece of text (typically a chat message, transcript, or note), extract:

1. entities: actors mentioned in the text. Type ∈ {${ENTITY_TYPE_VOCABULARY.join(', ')}}.
2. facts: assertions about those entities, using predicates from a closed vocabulary:
   said              — an utterance attributed to the entity (use only when no more specific predicate fits)
   name              — the entity's name (single value)
   email             — email address
   phone             — phone number
   status            — current state/lifecycle (e.g. "active", "churned", "open")
   tier              — segmentation tier (e.g. "platinum", "gold")
   intent            — inferred intent or goal (wants, plans, asks for)
   preference        — stated or inferred preference
   complained_about  — a complaint subject (problem reports, dissatisfaction)
   interacted_with   — generic interaction (booked, viewed, contacted, attended, purchased)
   address           — physical address
   dob               — date of birth

Rules:
- Only extract facts you can support from the text.
- Prefer the MOST SPECIFIC predicate. If \`complained_about\` or \`intent\`
  fits a sentence, do NOT also emit \`said\` for the same content —
  the specific predicate already captures the speech act.
- entityIndex is the 0-based index into the entities array.
- confidence is 0..1; reserve >0.8 for facts the text states explicitly,
  0.5–0.8 for inferred or implicit facts.
- Skip entities you cannot characterize beyond a pronoun.
- Set \`canonical\` to null unless the text explicitly states a canonical/legal form different from \`name\`.

Content-domain predicates (for marketing / brand / editorial mentions):
   brand_voice          — how the brand SOUNDS (single description, ≤500 chars).
                          SINGLETON: newer supersedes older. Extract the full
                          style description as one fact, not word-by-word.
   brand_archetype      — Jungian archetype. SINGLETON. One of: Hero, Sage,
                          Outlaw, Explorer, Magician, Lover, Jester, Caregiver,
                          Creator, Ruler, Innocent, Everyman.
   tone_of_voice        — style attributes (e.g. "confident, conversational,
                          no jargon"). SINGLETON.
   product_description  — short product summary (≤1000 chars). SINGLETON.
   target_audience_segment — one segment description. MULTI-VALUED: each
                          distinct segment becomes its own fact. Example:
                          "indie SaaS founders in EU/NA" → one fact;
                          "content creators on LinkedIn" → a second fact.
   content_guideline    — one editorial rule. MULTI-VALUED. Example:
                          "Always lead with a customer result" → one fact.
   tension_point        — one customer pain or contradiction the content
                          addresses. MULTI-VALUED.
   reference_example    — one URL or short quote of an exemplar piece.
                          MULTI-VALUED.
   narrative_pillar     — one theme the brand returns to. MULTI-VALUED.
   forbidden_pattern    — one anti-pattern (e.g. "Never use the word
                          'revolutionary'"). MULTI-VALUED.

SINGLETON vs MULTI-VALUED rule: for singleton predicates (brand_voice,
brand_archetype, tone_of_voice, product_description) emit EXACTLY ONE fact
per entity even if the text mentions multiple drafts — pick the most recent
or most specific. For multi-valued predicates, emit ONE fact per distinct
item; do not concatenate multiple items into one object string. Always prefer
a content-domain predicate when the brand itself is the subject — do NOT
fall back to \`said\` or \`intent\` when a content-domain predicate fits better.

Few-shot examples:
  Input: "Our brand voice is confident, witty, and never apologetic.
          We target indie SaaS founders in EU/NA and content creators
          who build on LinkedIn. Never say 'revolutionary'."
  Output facts (for entity: the brand):
    { predicate: "brand_voice", object: "confident, witty, never apologetic", confidence: 0.92 }
    { predicate: "target_audience_segment", object: "indie SaaS founders in EU/NA", confidence: 0.88 }
    { predicate: "target_audience_segment", object: "content creators who build on LinkedIn", confidence: 0.88 }
    { predicate: "forbidden_pattern", object: "Never say 'revolutionary'", confidence: 0.90 }

  Input: "Acme's Outlaw archetype shows up in every headline. Their tone
          is irreverent and warmly human, never corporate. Editorial rule:
          always lead with a customer quote."
  Output facts:
    { predicate: "brand_archetype", object: "Outlaw", confidence: 0.90 }
    { predicate: "tone_of_voice", object: "irreverent and warmly human, never corporate", confidence: 0.88 }
    { predicate: "content_guideline", object: "always lead with a customer quote", confidence: 0.87 }`;

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
        // Strict JSON Schema: predicate is a closed enum, so the
        // model can no longer hallucinate predicates outside our
        // vocabulary or skip required fields. Eliminates the main
        // source of run-to-run jitter we saw on the quality eval
        // (gpt-4o-mini occasionally producing "wants"/"says"/etc).
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'extraction',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
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
                      predicate: { type: 'string', enum: [...PREDICATE_VOCABULARY] },
                      object: { type: 'string' },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: ['entityIndex', 'predicate', 'object', 'confidence'],
                  },
                },
              },
              required: ['entities', 'facts'],
            },
          },
        },
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

    const facts: ExtractedFact[] = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter(
            (f: any) =>
              f &&
              Number.isInteger(f.entityIndex) &&
              f.entityIndex >= 0 &&
              f.entityIndex < entities.length &&
              typeof f.predicate === 'string' &&
              typeof f.object === 'string',
          )
          .map((f: any) => ({
            entityIndex: f.entityIndex,
            predicate: String(f.predicate).trim(),
            object: String(f.object).trim(),
            confidence:
              typeof f.confidence === 'number'
                ? Math.max(0, Math.min(1, f.confidence))
                : 0.5,
          }))
      : [];

    return { entities, facts };
  }

  private normalizeType(t: unknown): ExtractedEntity['type'] {
    const allowed = ['customer', 'staff', 'asset', 'project', 'topic', 'location', 'other'];
    if (typeof t === 'string' && allowed.includes(t)) return t as ExtractedEntity['type'];
    return 'other';
  }
}
