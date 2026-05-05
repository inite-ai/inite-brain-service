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

const DEFAULT_EXTRACTION_PROMPT = `You are an entity and fact extractor for a multi-vertical SaaS knowledge graph.

Given a piece of text (typically a chat message, transcript, or note), extract:

1. entities: actors mentioned in the text. Type ∈ {customer, staff, asset, project, topic, location, other}.
2. facts: assertions about those entities, using predicates from this vocabulary:
   said              — an utterance attributed to the entity
   name              — the entity's name (single value)
   email             — email address
   phone             — phone number
   status            — current state/lifecycle (e.g. "active", "churned", "open")
   tier              — segmentation tier (e.g. "platinum", "gold")
   intent            — inferred intent or goal
   preference        — stated or inferred preference
   complained_about  — a complaint subject
   interacted_with   — generic interaction (booked, viewed, contacted)
   address           — physical address
   dob               — date of birth

Rules:
- Only extract facts you can support from the text.
- Use the EXACT predicate strings above. If no listed predicate fits, omit the fact.
- entityIndex is the 0-based index into the entities array.
- confidence is 0..1; reserve >0.8 for facts the text states explicitly.
- Skip entities you cannot characterize beyond a pronoun.

Respond with valid JSON only:
{
  "entities": [{"name": "...", "type": "...", "canonical": "..." (optional)}],
  "facts": [{"entityIndex": 0, "predicate": "...", "object": "...", "confidence": 0.X}]
}`;

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
        response_format: { type: 'json_object' },
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
            canonical: e.canonical ? String(e.canonical).trim() : undefined,
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
