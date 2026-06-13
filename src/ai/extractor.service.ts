import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Semaphore } from '../common/semaphore';
import { traceArtifact } from '../common/debug-trace';
import {
  PredicateRegistryService,
  CORE_PREDICATES,
  PredicateDefinition,
} from './predicate-registry.service';

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

/**
 * Bootstrap-time predicate id list, derived from the JS seed. Kept as a
 * legacy export for callers that don't have a tenant context (e.g. the
 * chat router building a base JSON schema before any tenant is known).
 * The runtime per-tenant vocabulary comes from PredicateRegistryService
 * snapshots and may include additional tenant-specific predicates.
 */
export const PREDICATE_VOCABULARY = CORE_PREDICATES.map(
  (p) => p.predicateId,
);

const ENTITY_TYPE_VOCABULARY = [
  'customer',
  'staff',
  'asset',
  'project',
  'topic',
  'location',
  'other',
] as const;

/**
 * Static header — the structural / verbatim-rule / decompose-then-extract
 * contract. Predicate cards are appended dynamically per call from the
 * tenant's predicate registry snapshot, so adding a new predicate in the
 * registry immediately propagates to the prompt without code changes.
 */
const EXTRACTION_PROMPT_HEADER = `You are an entity-and-fact extractor for a knowledge graph.

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
below. Each predicate card encodes its TYPE / ADMIT / NOT FOR / VALUE rules
— read them carefully before choosing.

GENERAL RULES
  • Each clause produces zero or more facts. A clause that asserts no
    extractable predicate (e.g. a greeting) produces zero.
  • Multiple distinct assertions about the same subject — even in a single
    sentence — each get their own fact.
  • Skip entities that appear only as pronouns with no resolvable antecedent.
  • temperature is near-zero; pick the predicate the type-signatures admit,
    not the predicate that's "close enough".
  • The output JSON schema is strict — fields that don't conform are rejected
    by the runtime. valueSpan grounding is enforced server-side.

PREDICATE VOCABULARY
`;

function renderPredicateCard(p: PredicateDefinition): string {
  return `\n${p.predicateId} [${p.semantics}]\n${p.description.trim()}\n`;
}

function buildSystemPrompt(predicates: PredicateDefinition[]): string {
  return (
    EXTRACTION_PROMPT_HEADER +
    predicates.map(renderPredicateCard).join('\n')
  );
}

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly systemPromptHeader: string;
  private readonly limiter: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: PredicateRegistryService,
  ) {
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
    // The static EXTRACTION_SYSTEM_PROMPT override is no longer the source
    // of truth for vocabulary — that's the registry. The env var stays as
    // an escape hatch for operators who want to fully replace the prompt
    // header (everything before the dynamically-rendered predicate cards).
    this.systemPromptHeader =
      this.configService.get<string>('EXTRACTION_SYSTEM_PROMPT') ?? EXTRACTION_PROMPT_HEADER;
    const concurrency = parseInt(
      this.configService.get<string>('OPENAI_CONCURRENCY', '8'),
      10,
    );
    this.limiter = new Semaphore(concurrency);
  }

  async extract(
    text: string,
    companyId: string,
  ): Promise<ExtractionResult> {
    const trimmed = text.trim();
    if (!trimmed) return { entities: [], facts: [] };

    // Resolve the per-tenant active predicate set. Snapshot is TTL-cached
    // in the registry; the versionHash gets pinned in the trace so a
    // downstream audit can correlate an extraction with the registry
    // state it was made against.
    const snapshot = await this.registry.getSnapshot(companyId);
    const systemPrompt =
      this.systemPromptHeader === EXTRACTION_PROMPT_HEADER
        ? buildSystemPrompt(snapshot.active)
        : // Operator gave a custom header — render cards after their text.
          this.systemPromptHeader +
          snapshot.active.map(renderPredicateCard).join('\n');
    const vocab = snapshot.active.map((p) => p.predicateId);
    traceArtifact('extractor.vocab', {
      versionHash: snapshot.versionHash,
      predicateCount: vocab.length,
      predicateIds: vocab,
    });

    const res = await this.limiter.run(() =>
      this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: trimmed },
        ],
        // Strict JSON Schema with span-grounded objects. predicate is a
        // closed enum BUILT PER-CALL FROM THE TENANT REGISTRY so adding a
        // new predicate via admin propagates without code changes. valueSpan
        // is constrained to a string but grounded server-side (substring
        // containment in the input).
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
                      predicate: { type: 'string', enum: vocab },
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
