import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { PREDICATE_VOCABULARY } from '../ai/extractor.service';

/**
 * Classifies a free-form message into an ingest / search intent and pulls
 * any natural-language temporal anchors out of it. Lets the demo slide
 * behave like a real chat — "what did the CTO eat yesterday" routes to
 * search with asOf computed for yesterday automatically.
 *
 * One LLM call. JSON-schema strict output so the response shape is
 * stable enough to drive both branches without parsing prose.
 */
export interface ChatRoute {
  /** 'tell' = statement to ingest as a mention. 'ask' = question to search. */
  intent: 'tell' | 'ask';
  /**
   * Message rewritten with short references resolved to canonical entity
   * names from `knownNames`. Used as the actual ingest text for 'tell'
   * intents — fixes the "Maria" vs "Maria Petrov" duplicate problem where
   * the second mention used a first-name-only reference and NLU created
   * a fresh entity.
   */
  normalizedMessage?: string;
  /** Normalised query for search (only set when intent='ask'). Temporal
   *  hints are stripped AND short references are canonicalised so the
   *  retrieval lands on the known entity. */
  cleanedQuery?: string;
  /** ISO timestamp extracted from temporal phrases ("yesterday", "last
   *  month", "вчера", "в марте"). When set with intent='ask', the caller
   *  should pass it through to search as asOf. */
  asOf?: string;
  /** ISO timestamp for when the asserted fact became true. Set when
   *  intent='tell' and the message carries a temporal anchor that should
   *  shift validFrom OFF "now" — e.g. "switched to keto last month"
   *  should land facts with validFrom one month earlier so as-of-now
   *  search sees keto and as-of-two-months-ago sees vegan. */
  validFrom?: string;
  /** Known canonical names that the LLM identifies as the SUBJECT(s) of the
   *  question. Drives graph-first retrieval: instead of trying to substring
   *  match the full sentence against entity names (which never works), we
   *  directly look up the named entities the operator is asking about.
   *  Empty when the query is topical with no named subject. */
  entityRefs?: string[];
  /** Closed-vocab predicates the question is asking about. Drives
   *  predicate-aware retrieval: "where lives" → ["address"]; "what eats" →
   *  ["preference"]; "where lives and what eats" → ["address","preference"].
   *  Empty when the question is general ("tell me about X") — the graph
   *  query then falls back to top-N recency + confidence so we don't dump
   *  the entire subject into context. This is the same single-call pattern
   *  Haystack's QueryMetadataExtractor and mem0's filter-builder use. */
  predicateHints?: string[];
  /** Free-text rationale the LLM gave — surfaced only for the debug trace. */
  reason?: string;
}

@Injectable()
export class ChatRouterService {
  private readonly logger = new Logger(ChatRouterService.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: 15_000,
      maxRetries: 1,
    });
    this.model = this.config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
  }

  async route(
    message: string,
    options: { knownNames?: string[]; now?: Date } = {},
  ): Promise<ChatRoute> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const knownNames = options.knownNames ?? [];
    const system = `You route a free-form chat message to a knowledge-graph backend.

Decide intent:
  - "tell" — the user is stating a fact or asserting new information (declarative).
  - "ask" — the user is querying existing knowledge (interrogative or imperative search).

Entity canonicalisation (CRITICAL — this is what keeps the graph from accumulating
duplicate people / orgs across mentions):
  The graph already knows the entities listed under "known canonical names".
  If the user uses a short reference (first name, alias, possessive pronoun chain
  that resolves to one of them) that UNAMBIGUOUSLY matches exactly one known
  name, rewrite the message to use the full canonical form.

  HARD RULE — normalizedMessage MUST preserve every clause / fact in the original
  message. Substitute names only. DO NOT drop clauses. DO NOT summarise. DO NOT
  collapse a multi-fact sentence into one fact. Word count should stay within
  ±25% of the original. If you find yourself shortening, you are doing it wrong.

  Allowed transformations on normalizedMessage:
    1. Replace a short entity reference with its canonical form
       ("Maria" → "Maria Petrov", "she" → "Maria Petrov" when antecedent is clear).
    2. Replace change-of-state verbs with a present-tense predicate noun, but
       ONLY the verb phrase — every other clause stays verbatim:
         "switched to keto"     → "now prefers keto"
         "moved to Berlin"      → "now lives in Berlin"
         "started using Stripe" → "uses Stripe"
       This helps the downstream extractor classify the fact as a stable
       preference / location / tool rather than a transient action.
    3. Strip a leading temporal anchor ("since February", "last month") IF you
       returned it as validFrom — the timestamp is captured separately and
       repeating it adds nothing.

  Example (multi-fact):
    known = ["Maria Petrov"], message =
      "since February Maria is our new CTO at Acme. She moved from Berlin and prefers vegan lunch."
    →
      normalizedMessage = "Maria Petrov is our new CTO at Acme. Maria Petrov lives in Berlin and prefers vegan lunch."
      validFrom         = <Feb 1 ISO>
    Note: three facts in the original — CTO@Acme, lives-in Berlin, prefers vegan
    lunch. THREE facts in the normalized form. None dropped.

  Example (short ref + change of state, single fact):
    known = ["Maria Petrov"], message = "Maria switched to keto last month"
    →
      normalizedMessage = "Maria Petrov now prefers keto"
      validFrom         = <1 month ago ISO>

  If a short reference matches MORE than one known name, leave the original
  message in place and let the operator clarify.

Entity references (CRITICAL for retrieval):
  Return entityRefs — the subset of "known canonical names" that the
  message is ABOUT. For "what does Maria eat" with known=["Maria Petrov"],
  return ["Maria Petrov"]. For "what does Maria eat in Berlin" return
  ["Maria Petrov", "Berlin"] only if Berlin is in known. This drives
  graph-first lookup — without it the backend has to fall back to vector
  search every time. If no known name is referenced, return [].

Predicate hints (only for intent="ask" — slot the question into the graph):
  The knowledge graph stores facts under a closed predicate vocabulary.
  When intent="ask", return predicateHints — the subset of predicates the
  question is asking about. The retriever uses this as a hard AND-filter
  so the graph doesn't dump every fact about the subject into the LLM
  context window.

  Mapping intent → predicate (best effort; pick predicates that admit the
  question, multilingual phrasing is fine):
    "where does X live / where is X based / куда переехал / адрес"
        → ["address"]
    "what does X eat / prefer / like / favourite / любимое"
        → ["preference"]
    "what does X want / plan / need / planning to"
        → ["intent"]
    "what is X's role / position / status / title / должность"
        → ["status"]
    "what is X's tier / plan / segment"
        → ["tier"]
    "what's X's email / phone / contact / contact info"
        → ["email", "phone"]
    "what's X's brand voice / tone / archetype / target audience /
        editorial guidelines"
        → one or more of the content-domain predicates that admit it
    "where lives AND what eats" (compound)
        → ["address", "preference"] — union, both slots get fetched
    "tell me about X" / "what do we know about X" / general / unknown
        → [] — empty hints, retriever falls back to top-N recency

  Rules:
   - Only emit predicates from the closed vocabulary above. Anything else
     is dropped server-side.
   - For intent="tell", predicateHints MUST be []. The extractor picks
     predicates during ingest, not the router.
   - When you can't pin a specific predicate confidently, return []. The
     retriever's recency fallback returns a sensible top-N for the subject
     — that's better than guessing wrong and silently dropping the
     relevant fact.

Temporal handling:
  When intent="ask", extract any temporal anchor ("yesterday", "last month",
  "in March", "вчера", "на прошлой неделе") and return it as an ISO 8601 asOf
  timestamp computed relative to "now". Strip the temporal phrase from
  cleanedQuery so retrieval runs on the topical content alone.

  When intent="tell" AND the message carries a temporal anchor indicating WHEN
  the asserted fact became true ("switched to keto LAST MONTH", "joined in
  MARCH", "moved YESTERDAY"), return that as validFrom (ISO 8601). This makes
  bitemporal facts work from chat — without it every chat-ingested fact would
  land with validFrom=now and an as-of-past search would miss it.
  When the tell has no temporal anchor, leave validFrom null and the ingest
  will default to now.

Rules:
  - Always pick one of the two intents.
  - asOf and validFrom must each be a valid ISO 8601 timestamp or null.
  - normalizedMessage falls back to the original message when no canonicalisation
    applies.
  - cleanedQuery is only set for ask intent.
  - For "tell" intents asOf must always be null. For "ask" intents validFrom
    must always be null.

Reply with strict JSON.`;

    const user = `now: ${nowIso}
known canonical names: ${JSON.stringify(knownNames)}
message: ${message}`;

    return traceSpan('demo.chat.route', async () => {
      traceArtifact('demo.chat.prompt', { system, user, model: this.model });
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
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                intent: { type: 'string', enum: ['tell', 'ask'] },
                normalizedMessage: { type: ['string', 'null'] },
                cleanedQuery: { type: ['string', 'null'] },
                entityRefs: { type: 'array', items: { type: 'string' } },
                predicateHints: {
                  type: 'array',
                  items: { type: 'string', enum: [...PREDICATE_VOCABULARY] },
                  description:
                    'Closed-vocab predicates the question is asking about. Used as a hard AND-filter in graph retrieval so we do not dump every fact of the subject. Empty for general/unknown questions and ALWAYS empty for intent=tell.',
                },
                asOf: { type: ['string', 'null'] },
                validFrom: { type: ['string', 'null'] },
                reason: { type: ['string', 'null'] },
              },
              required: [
                'intent',
                'normalizedMessage',
                'cleanedQuery',
                'entityRefs',
                'predicateHints',
                'asOf',
                'validFrom',
                'reason',
              ],
            },
          },
        },
        temperature: 0,
        max_completion_tokens: 400,
      });
      const content = res.choices[0]?.message?.content;
      const finish = res.choices[0]?.finish_reason;
      traceArtifact('demo.chat.raw', { content, finish_reason: finish });
      if (!content) {
        this.logger.warn(
          `chat router returned empty content (finish=${finish}) — falling back to safe default`,
        );
        const fallback: ChatRoute = {
          intent: 'tell',
          reason: 'router-empty-fallback',
        };
        traceArtifact('demo.chat.route', fallback);
        return fallback;
      }
      let parsed: {
        intent: 'tell' | 'ask';
        normalizedMessage: string | null;
        cleanedQuery: string | null;
        entityRefs?: string[];
        predicateHints?: string[];
        asOf: string | null;
        validFrom: string | null;
        reason: string | null;
      };
      try {
        parsed = JSON.parse(extractJsonObject(content));
      } catch (err) {
        // Defensive: LLMs occasionally emit leading nulls / partial trailing
        // tokens / unexpected markdown fences even in strict json_schema mode.
        // Better to fall back to a safe default than to crash the whole chat
        // turn — the demo MUST be live-presentable.
        this.logger.warn(
          `chat router JSON parse failed (finish=${finish}): ${(err as Error).message}; raw="${content.slice(0, 200)}" — using fallback route`,
        );
        const fallback: ChatRoute = {
          intent: 'tell',
          reason: `router-parse-fallback: ${(err as Error).message}`,
        };
        traceArtifact('demo.chat.route', fallback);
        return fallback;
      }
      const out: ChatRoute = { intent: parsed.intent };
      if (
        parsed.normalizedMessage &&
        parsed.normalizedMessage.trim() &&
        parsed.normalizedMessage !== message
      ) {
        // Guardrail: an over-eager LLM has been observed turning multi-fact
        // tells like "Maria is CTO. She moved from Berlin and prefers vegan
        // lunch." into a single-clause "Maria now serves as CTO" — silently
        // dropping facts. Reject any rewrite that compresses the original
        // by more than 40% of word count and fall back to the original
        // message. The validFrom / entityRefs fields are still trusted.
        const origWords = message.trim().split(/\s+/).filter(Boolean).length;
        const normWords = parsed.normalizedMessage
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        if (origWords >= 8 && normWords < origWords * 0.6) {
          this.logger.warn(
            `chat router rewrite dropped too many words ` +
              `(${origWords}→${normWords}); falling back to original`,
          );
          traceArtifact('demo.chat.rewrite_rejected', {
            origWords,
            normWords,
            normalized: parsed.normalizedMessage,
          });
        } else {
          out.normalizedMessage = parsed.normalizedMessage;
        }
      }
      if (parsed.cleanedQuery) out.cleanedQuery = parsed.cleanedQuery;
      // Only keep entityRefs that are actually in the known list — guard
      // against hallucinated names that wouldn't resolve anyway.
      if (Array.isArray(parsed.entityRefs) && parsed.entityRefs.length > 0) {
        const known = new Set(knownNames);
        const filtered = parsed.entityRefs.filter((n) => known.has(n));
        if (filtered.length > 0) out.entityRefs = filtered;
      }
      // predicateHints already constrained by the json_schema enum, but
      // belt-and-suspenders: filter to known vocab + drop on tell intent
      // (the extractor picks predicates at ingest, not the router).
      if (
        parsed.intent === 'ask' &&
        Array.isArray(parsed.predicateHints) &&
        parsed.predicateHints.length > 0
      ) {
        const vocab = new Set<string>(PREDICATE_VOCABULARY);
        const filtered = Array.from(
          new Set(parsed.predicateHints.filter((p) => vocab.has(p))),
        );
        if (filtered.length > 0) out.predicateHints = filtered;
      }
      if (parsed.asOf && isValidIso(parsed.asOf)) out.asOf = parsed.asOf;
      if (parsed.validFrom && isValidIso(parsed.validFrom)) {
        out.validFrom = parsed.validFrom;
      }
      if (parsed.reason) out.reason = parsed.reason;
      traceArtifact('demo.chat.route', out);
      return out;
    });
  }
}

function isValidIso(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/**
 * Extracts the first balanced top-level JSON object from a possibly noisy
 * LLM output. Handles the failure modes we've actually seen in production:
 *   - leading `null` or `true` token before the real object
 *   - markdown code fences (```json ... ```)
 *   - trailing prose after the closing brace
 * Throws if no balanced object is found.
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
