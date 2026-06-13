import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { traceArtifact, traceSpan } from '../common/debug-trace';

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

  Example: known names = ["Maria Petrov", "Acme"], message = "Maria switched to keto"
    → normalizedMessage = "Maria Petrov switched to keto"
    → cleanedQuery     = "Maria Petrov diet" (for ask intent)

  If the short reference matches MORE than one known name, do NOT rewrite —
  leave the original message in place and let the operator clarify.

Temporal handling:
  When intent="ask", extract any temporal anchor ("yesterday", "last month",
  "in March", "вчера", "на прошлой неделе") and return it as an ISO 8601 asOf
  timestamp computed relative to "now". Strip the temporal phrase from
  cleanedQuery so retrieval runs on the topical content alone.

When intent="tell", do NOT compute asOf — emittedAt=now is correct.

Rules:
  - Always pick one of the two intents.
  - asOf must be a valid ISO 8601 timestamp or null.
  - normalizedMessage falls back to the original message when no canonicalisation
    applies.
  - cleanedQuery is only set for ask intent.

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
                asOf: { type: ['string', 'null'] },
                reason: { type: ['string', 'null'] },
              },
              required: [
                'intent',
                'normalizedMessage',
                'cleanedQuery',
                'asOf',
                'reason',
              ],
            },
          },
        },
        temperature: 0,
        max_completion_tokens: 200,
      });
      const content = res.choices[0]?.message?.content;
      if (!content) throw new Error('router returned empty response');
      const parsed = JSON.parse(content) as {
        intent: 'tell' | 'ask';
        normalizedMessage: string | null;
        cleanedQuery: string | null;
        asOf: string | null;
        reason: string | null;
      };
      const out: ChatRoute = { intent: parsed.intent };
      if (
        parsed.normalizedMessage &&
        parsed.normalizedMessage.trim() &&
        parsed.normalizedMessage !== message
      ) {
        out.normalizedMessage = parsed.normalizedMessage;
      }
      if (parsed.cleanedQuery) out.cleanedQuery = parsed.cleanedQuery;
      if (parsed.asOf && isValidIso(parsed.asOf)) out.asOf = parsed.asOf;
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
