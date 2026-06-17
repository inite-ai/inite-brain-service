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
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import { ExtractorCacheService } from './extractor-cache.service';
import { splitClauses } from './clause-splitter';

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

/**
 * Entity-entity relationship the extractor identified ("X works at Y",
 * "X joined Y", "X owns Y"). The chat router doesn't traverse facts;
 * graph queries traverse EDGES — without edges between named entities
 * a question like "who works at Acme" can't reach Maria's role even
 * when both facts exist independently.
 *
 * `kind` is open-vocabulary (works_at, lives_at, owns, knows,
 * affiliated_with, …) — same EDC philosophy as predicates. Downstream
 * canonicalisation of edge kinds is deferred (analogous to predicate
 * canonicalize() — to be added when the registry covers edge types).
 */
export interface ExtractedEdge {
  /** Index into entities[] — source of the relationship. */
  fromEntityIndex: number;
  /** Index into entities[] — target of the relationship. */
  toEntityIndex: number;
  /** Relationship type — lowercase snake_case verb-shape. */
  kind: string;
  /** 0..1 — extractor's confidence. */
  confidence: number;
  /** Optional verbatim clause that warranted this edge — trace only. */
  clause?: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  edges: ExtractedEdge[];
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
You output JSON with four top-level fields, in this order:

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

  4. edges[] — entity-to-entity relationships the input asserts. A fact captures
     an attribute of ONE entity (Maria.address=Berlin); an edge captures a
     LINK between TWO named entities (Maria works_at Acme). Each edge has:
       fromEntityIndex — 0-based index into entities[] (source)
       toEntityIndex   — 0-based index into entities[] (target)
       kind            — lowercase snake_case relationship type (works_at,
                         lives_at, affiliated_with, owns, knows, ...)
       clauseIndex     — 0-based index into clauses[]
       confidence      — 0..1

     Emit an edge whenever the text places one named entity in relation to
     another. "X is the CTO at Y" → edge (X, works_at, Y). "X joined Y" →
     edge (X, works_at, Y). "X owns Y" → edge (X, owns, Y). "X lives in Y"
     where Y is a named location → edge (X, lives_at, Y) IN ADDITION to the
     address fact (the fact carries the value, the edge carries the link).

     Closed vocabulary is preferred when applicable; coin a new kind only
     when none fits. Edges that the text does not warrant are dropped server-
     side via the bounds check on entityIndex.

THE VERBATIM RULE (most important):
  valueSpan MUST appear character-for-character somewhere in the input.
  • Copy from the source. Do not paraphrase.
  • Do not substitute a synonym, a normalised form, or a canonical label.
  • Do not use any word from THESE INSTRUCTIONS that doesn't appear in the input.
  • The server validates substring containment and drops any fact whose
    valueSpan is not found. A dropped fact is worse than a missing fact.
  • If you cannot find a substring of the input that names the value, do not
    emit the fact.

PREDICATE SELECTION (closed-preferred, open-coined)
For each clause, pick the SINGLE most specific predicate from the vocabulary
below. Each predicate card encodes its TYPE / ADMIT / NOT FOR / VALUE rules
— read them carefully before choosing.

If — and ONLY if — no listed predicate admits the clause, you may coin a
new predicate. Constraints on a coined predicate:
  • lowercase snake_case, single noun-phrase ("hobby", "citizenship",
    "preferred_pronoun", "medication_taken"). NOT verb phrases.
  • Must describe the SHAPE of the assertion, not a specific value.
  • Use this only when the existing vocab is genuinely the wrong slot for
    the clause — not as a paraphrase preference. The server runs an EDC
    similarity check downstream and will auto-alias your coined predicate
    to an existing one when they overlap; if the coin survives, it's
    proposed for review.
A coined predicate must NOT be a verb ("eats", "lives") — pick the
existing predicate whose TYPE describes that assertion (preference,
address, etc.) instead.

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
    private readonly localPredicates: LocalPredicateSelectorService,
    private readonly extractionCache: ExtractorCacheService,
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
    if (!trimmed) return { entities: [], facts: [], edges: [] };

    // Resolve the per-tenant active predicate set. Snapshot is TTL-cached
    // in the registry; the versionHash gets pinned in the trace so a
    // downstream audit can correlate an extraction with the registry
    // state it was made against. Defensive: a registry failure
    // (bootstrap problem, migration not yet applied, embedder hiccup)
    // MUST NOT 500 the extractor — fall back to the JS-seed
    // CORE_PREDICATES so the extractor still has cards to render.
    let snapshot: { versionHash: string; active: PredicateDefinition[] };
    try {
      snapshot = await this.registry.getSnapshot(companyId);
    } catch (e) {
      this.logger.warn(
        `extractor: registry getSnapshot failed for ${companyId}: ${(e as Error).message}; falling back to CORE_PREDICATES seed`,
      );
      snapshot = {
        versionHash: 'fallback-seed',
        active: CORE_PREDICATES.filter((p) => p.status === 'active'),
      };
    }
    const systemPrompt =
      this.systemPromptHeader === EXTRACTION_PROMPT_HEADER
        ? buildSystemPrompt(snapshot.active)
        : // Operator gave a custom header — render cards after their text.
          this.systemPromptHeader +
          snapshot.active.map(renderPredicateCard).join('\n');
    const vocab = snapshot.active.map((p) => p.predicateId);

    // Exact-key cache check. Same (text, tenant, registry version) →
    // same extraction. Hit replays the previously validated result
    // without re-running OpenAI; cache miss flows through the normal
    // pipeline and the result is cached at the end.
    const cacheKey = this.extractionCache.computeKey({
      text: trimmed,
      companyId,
      predicateVocabHash: snapshot.versionHash,
    });
    const cached = this.extractionCache.get(cacheKey);
    if (cached) {
      traceArtifact('extractor.cache_decision', {
        hit: true,
        key: cacheKey,
        registryVersionHash: snapshot.versionHash,
      });
      return cached;
    }
    traceArtifact('extractor.cache_decision', {
      hit: false,
      key: cacheKey,
      registryVersionHash: snapshot.versionHash,
    });

    // Local clause split — observability foundation for the skip-LLM
    // path. Subsequent sprints (E3 local NER, E6 pattern cache, E7
    // skip gate) consume these clauses; today we only emit them as a
    // trace artifact so the operator can compare local vs LLM-emitted
    // clauses while tuning.
    const localClauses = splitClauses(trimmed);
    traceArtifact('extractor.local_clauses', {
      count: localClauses.length,
      clauses: localClauses,
    });

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
                      // Open vocabulary (EDC pattern) — model is told via
                      // prompt that the listed predicates are the known
                      // vocab and should be preferred when one fits, but
                      // is allowed to coin a novel predicate when none do.
                      // The server runs predicate-registry.canonicalize
                      // downstream which either matches, auto-aliases, or
                      // proposes the novel predicate for review.
                      predicate: {
                        type: 'string',
                        description:
                          'Prefer a predicate from the listed vocabulary. Coin a new lowercase snake_case predicate ONLY when no listed one admits the clause — the server will canonicalize it via EDC similarity search downstream.',
                      },
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
                edges: {
                  type: 'array',
                  description:
                    'Entity-to-entity relationships. Bridge two named entities. "Maria is CTO at Acme" → edge (Maria, works_at, Acme). Without edges, graph traversal cannot reach Maria from Acme.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      fromEntityIndex: { type: 'integer', minimum: 0 },
                      toEntityIndex: { type: 'integer', minimum: 0 },
                      kind: {
                        type: 'string',
                        description:
                          'Lowercase snake_case relationship type. Common: works_at, lives_at, affiliated_with, owns, knows, located_in.',
                      },
                      clauseIndex: { type: 'integer', minimum: 0 },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: [
                      'fromEntityIndex',
                      'toEntityIndex',
                      'kind',
                      'clauseIndex',
                      'confidence',
                    ],
                  },
                },
              },
              required: ['clauses', 'entities', 'facts', 'edges'],
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
    if (!content) return { entities: [], facts: [], edges: [] };

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      this.logger.warn(`Extractor returned non-JSON: ${(err as Error).message}`);
      return { entities: [], facts: [], edges: [] };
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
      const clauseText =
        rf.clauseIndex !== undefined && rf.clauseIndex < clauses.length
          ? clauses[rf.clauseIndex]
          : undefined;
      facts.push({
        entityIndex: rf.entityIndex,
        predicate: rf.predicate,
        object: rf.valueSpan,
        confidence: rf.confidence,
        clause: clauseText,
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

    // Edges — entity-to-entity relationships. Each edge bridges two
    // already-validated entities; dropped when an index points outside
    // entities[], or the same entity (self-edge is meaningless), or
    // when the kind is empty. No span grounding — kind is a coined
    // verb-shape, not a substring of the input.
    const droppedEdges: Array<{ kind?: string; reason: string }> = [];
    const edges: ExtractedEdge[] = [];
    if (Array.isArray(parsed.edges)) {
      for (const e of parsed.edges as Array<Record<string, unknown>>) {
        if (!e || typeof e !== 'object') continue;
        const from = Number(e.fromEntityIndex);
        const to = Number(e.toEntityIndex);
        const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
        if (
          !Number.isInteger(from) ||
          !Number.isInteger(to) ||
          from < 0 ||
          to < 0 ||
          from >= entities.length ||
          to >= entities.length
        ) {
          droppedEdges.push({
            kind: kind || undefined,
            reason: 'entity_index_out_of_bounds',
          });
          continue;
        }
        if (from === to) {
          droppedEdges.push({ kind, reason: 'self_edge' });
          continue;
        }
        if (kind.length === 0) {
          droppedEdges.push({ kind: undefined, reason: 'empty_kind' });
          continue;
        }
        const clauseIndex =
          Number.isInteger(e.clauseIndex) && (e.clauseIndex as number) >= 0
            ? (e.clauseIndex as number)
            : undefined;
        const clauseText =
          clauseIndex !== undefined && clauseIndex < clauses.length
            ? clauses[clauseIndex]
            : undefined;
        const confidence =
          typeof e.confidence === 'number'
            ? Math.max(0, Math.min(1, e.confidence))
            : 0.7;
        edges.push({
          fromEntityIndex: from,
          toEntityIndex: to,
          kind,
          confidence,
          ...(clauseText ? { clause: clauseText } : {}),
        });
      }
    }
    if (edges.length > 0) {
      traceArtifact('extractor.edges', edges);
    }
    if (droppedEdges.length > 0) {
      traceArtifact('extractor.invalid_edges', { dropped: droppedEdges });
    }

    // Local predicate selection — embed each clause and pick the
    // canonical predicate with highest cosine similarity vs the
    // registry's per-predicate description embeddings (already cached
    // from bootstrap, migration 0012). This catches the dominant
    // failure mode of the downstream canonicalize() pass: short coined
    // names like "job_title" rarely hit cosine 0.85 against verbose
    // predicate cards like the `status` description, but the CLAUSE
    // "Maria is our new CTO at Acme" scores much higher because both
    // share role-shaped vocabulary.
    //
    // Override the LLM-coined predicate ONLY when local top-1 is above
    // EXTRACTOR_LOCAL_PREDICATE_THRESHOLD (default 0.45 — tuned for
    // text-embedding-3-small on CORE cards). Below threshold, the
    // LLM-coined predicate flows through to canonicalize() unchanged.
    const localThreshold = parseFloat(
      this.configService.get<string>(
        'EXTRACTOR_LOCAL_PREDICATE_THRESHOLD',
        '0.45',
      ),
    );
    let snapshotForLocal:
      | Awaited<ReturnType<PredicateRegistryService['getSnapshot']>>
      | null = null;
    try {
      snapshotForLocal = snapshot as Awaited<
        ReturnType<PredicateRegistryService['getSnapshot']>
      >;
    } catch {
      snapshotForLocal = null;
    }
    const localOverrides: Array<{
      original: string;
      override: string;
      similarity: number;
      clauseIndex?: number;
    }> = [];
    for (const f of facts) {
      if (!f.clause) continue;
      const ranked = await this.localPredicates.rank(f.clause, snapshotForLocal, 3);
      if (ranked.length === 0) continue;
      const top = ranked[0];
      if (top.similarity < localThreshold) continue;
      if (top.predicateId === f.predicate) continue;
      localOverrides.push({
        original: f.predicate,
        override: top.predicateId,
        similarity: top.similarity,
      });
      f.predicate = top.predicateId;
    }
    if (localOverrides.length > 0) {
      traceArtifact('extractor.local_predicate_override', {
        threshold: localThreshold,
        decisions: localOverrides,
      });
    }

    // EDC canonicalization pass. For each fact, ask the registry to
    // resolve the (possibly-novel) predicate to its canonical id —
    // either matching an existing predicate, auto-aliasing a similar
    // novel one, or inserting it as proposed. The fact's predicate
    // field is rewritten to the canonical id before returning so
    // downstream (conflict resolver, fact upsert) treats it uniformly.
    //
    // Defensive: the whole pass is wrapped in a try — if the registry
    // is unavailable (migration not yet applied / network blip),
    // facts keep their model-emitted predicates and downstream
    // policyFor() falls back to DEFAULT_POLICY. The extraction must
    // not 500 the chat path.
    try {
      if (facts.length > 0) {
      const decisions: Array<{
        original: string;
        canonical: string;
        kind: 'matched' | 'aliased' | 'proposed';
        similarity?: number;
        bestMatchId?: string;
      }> = [];
      for (const f of facts) {
        const contextText = `${f.predicate}: ${f.object}${
          f.clause ? ` (clause: ${f.clause})` : ''
        }`;
        try {
          const decision = await this.registry.canonicalize(
            companyId,
            f.predicate,
            contextText,
          );
          if (decision.canonicalId !== f.predicate) {
            decisions.push({
              original: f.predicate,
              canonical: decision.canonicalId,
              kind: decision.kind,
              ...(decision.kind === 'aliased'
                ? { similarity: decision.similarity }
                : {}),
              ...(decision.kind === 'proposed' && decision.bestMatch
                ? {
                    similarity: decision.bestMatch.similarity,
                    bestMatchId: decision.bestMatch.predicateId,
                  }
                : {}),
            });
            f.predicate = decision.canonicalId;
          } else if (decision.kind !== 'matched') {
            decisions.push({
              original: f.predicate,
              canonical: decision.canonicalId,
              kind: decision.kind,
              ...(decision.kind === 'aliased'
                ? { similarity: decision.similarity }
                : {}),
            });
          }
        } catch (e) {
          this.logger.warn(
            `canonicalize failed for predicate '${f.predicate}': ${(e as Error).message}`,
          );
        }
      }
      if (decisions.length > 0) {
        traceArtifact('extractor.canonicalize', decisions);
      }
      }
    } catch (e) {
      this.logger.warn(
        `extractor: canonicalize pass failed: ${(e as Error).message}; keeping model-emitted predicates`,
      );
    }

    const result: ExtractionResult = { entities, facts, edges };
    this.extractionCache.set(cacheKey, result);
    return result;
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
