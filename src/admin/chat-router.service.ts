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
  /** Normalised query for search (only set when intent='ask'). Temporal
   *  hints are stripped so the lexical/vector retrieval doesn't match on
   *  "yesterday" itself. */
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

  async route(message: string, now: Date = new Date()): Promise<ChatRoute> {
    const nowIso = now.toISOString();
    const system = `You route a free-form chat message to a knowledge-graph backend.
Decide intent:
  - "tell" — the user is stating a fact or asserting new information (declarative).
  - "ask" — the user is querying existing knowledge (interrogative or imperative search).

When intent="ask", extract any temporal anchor present in the message ("yesterday",
"last month", "in March", "вчера", "на прошлой неделе", etc.) and return it as an
ISO 8601 asOf timestamp computed relative to "now". Strip the temporal phrase
from cleanedQuery so the search runs on the topical content alone.

When intent="tell", do NOT compute asOf — let the ingest pipeline use emittedAt=now.
You may still leave cleanedQuery empty for tell.

Rules:
  - Always pick one of the two intents. Default to "ask" if a sentence is
    ambiguous and ends with a question word.
  - asOf must be either a valid ISO 8601 timestamp (UTC) or omitted.
  - Be conservative — only set asOf when a temporal phrase is explicitly present.

Reply with strict JSON.`;

    const user = `now: ${nowIso}\nmessage: ${message}`;

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
                cleanedQuery: { type: ['string', 'null'] },
                asOf: { type: ['string', 'null'] },
                reason: { type: ['string', 'null'] },
              },
              required: ['intent', 'cleanedQuery', 'asOf', 'reason'],
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
        cleanedQuery: string | null;
        asOf: string | null;
        reason: string | null;
      };
      const out: ChatRoute = { intent: parsed.intent };
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
