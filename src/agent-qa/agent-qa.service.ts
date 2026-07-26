import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SearchService } from '../search/search.service';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { MultiHopService } from '../multi-hop/multi-hop.service';
import { getAbortSignal } from '../common/request-context';
import { withSpan } from '../common/tracing';
import { envFlagEnabled } from '../common/env-validation';

/**
 * AgentQaService — agent-in-loop question answering.
 *
 * The single-shot path (search → synthesize) caps multi-hop QA because it
 * retrieves once and answers once: it cannot rewrite a bad query, chain
 * evidence discovered mid-reasoning, or decide it needs one more lookup.
 * This service runs the ReAct loop the literature shows is the biggest
 * lever on LoCoMo (single-shot ~67 → agentic ~74-85): an LLM issues
 * `search_memory` tool calls, inspects the returned facts, reformulates,
 * chains, and commits to a short answer when it has enough.
 *
 * It reuses the existing SearchService (all retrieval machinery — hybrid
 * legs, scoring, edge/PPR, rerank) as the tool; nothing new on the storage
 * side. Never abstains: an abstention scores strictly worse than a
 * best-effort answer under the QA judge.
 */

// NB: an "aggregation + single-hop-directness" rewrite of this prompt was
// A/B'd on LoCoMo and REGRESSED both gpt-4o-mini (47.4→42.1) and gpt-4.1
// (→43.4). Reverted to this version. Lesson: the bottleneck is retrieval, not
// the answer prompt — gpt-4.1 didn't beat gpt-4o-mini either.
const SYSTEM_PROMPT = `You answer questions about a long, multi-session conversation between people, using a memory-search tool.

How to work:
- Call search_memory as many times as you need. Reformulate the query, try different phrasings and entity names, and chain searches to assemble multi-step (multi-hop) evidence. A first search that returns nothing useful is normal — search again with a better query.
- The memory returns atomic facts in the form "[Person] predicate: value (date)". Reason over them; the date is when the fact was recorded/valid.
- When you have enough, give a SHORT, CONCRETE answer — usually a few words (a name, a date, a place, a count, a short phrase). Match the granularity the question asks for; do not pad with explanation.
- ALWAYS commit to an answer. If the memory is thin, give your single best guess from what you found. NEVER refuse, never reply "I don't know", "not mentioned", or "no information".`;

/**
 * V2 loop prompt (AGENT_QA_TOOLS_V2, memory-rebuild R3): three typed
 * tools + the date-arithmetic discipline the Letta harness measured as
 * load-bearing. Search results are MASKED — facts already shown are
 * never repeated, so every search must surface NEW evidence (the
 * largest ablation in the iterative-retrieval literature).
 */
const SYSTEM_PROMPT_V2 = `You answer questions about a long, multi-session conversation between people, using memory tools.

Tools and when to use them:
- search_memory: your default. Start by searching the QUESTION VERBATIM, then reformulate with different phrasings and entity names. Results are deduplicated across calls — repeated searches return only NEW facts, so keep queries varied.
- timeline: for "how many times", "list/name all", "what are the different", "first/last/when did X start" questions — returns topic-related facts in chronological order so you can collect and count instances completely.
- grep_episodes: literal word search over the RAW conversation turns. Use for exact names, titles, quoted phrases, and details too specific for semantic search.

Date discipline:
- Always convert relative time references to specific dates: if a memory dated 4 May 2023 says "went to India last year", the trip was in 2022. "This summer" is not precise; "June 2023" is precise.
- The date in parentheses is when the fact was recorded/valid. If memories contradict, prefer the most recent.
- Do not confuse people mentioned INSIDE memories with the speakers who created them.

Answering:
- When you have enough, give a SHORT, CONCRETE answer — a name, a date, a place, a count, a short phrase. Match the granularity the question asks for.
- ALWAYS commit to an answer. If evidence is thin, give your single best guess. NEVER refuse, never reply "I don't know", "not mentioned", or "no information".`;

const GREP_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'grep_episodes',
    description:
      'Literal keyword search over the raw conversation transcript. Returns matching turns as "[date] speaker: text" lines. Best for exact names, titles, and quoted phrases.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: 'Words to match literally in turn text.',
        },
      },
      required: ['pattern'],
    },
  },
};

const TIMELINE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'timeline',
    description:
      'Chronological scan of memory facts related to a topic or person — returns dated facts oldest-first so instances can be collected and counted completely. Use for enumeration, counting, and first/last questions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          description:
            'The topic, activity, or person to scan chronologically.',
        },
      },
      required: ['topic'],
    },
  },
};

const SEARCH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search_memory',
    description:
      'Search the conversation memory for facts relevant to a focused query. Returns the top matching facts as "[Person] predicate: value (date)" lines.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'A focused natural-language search phrase.',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * Parse a positive integer from an env value, falling back on unset / empty /
 * non-numeric / zero / negative. Without this a typo like AGENT_QA_MAX_ROUNDS=0
 * (or garbage) makes the ReAct loop never run — the request then answers from
 * ZERO retrieved facts, i.e. pure hallucination, which the never-abstain prompt
 * confidently presents. Fail safe to the default instead.
 */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface AgentQaInput {
  companyId: string;
  question: string;
  callerScopes: string[];
  asOf?: string;
}

export interface AgentQaResult {
  answer: string;
  /** Number of tool-call rounds the agent used. */
  rounds: number;
  /** Distinct search queries the agent issued (for tracing). */
  queries: string[];
  /** Escalation routing (AGENT_QA_ROUTE_MODE=escalate): whether the
   *  one-shot answer was kept (false) or the loop ran (true). */
  escalated?: boolean;
}

/** Hedging phrases that mark a one-shot answer as too weak to keep. */
const HEDGE = new RegExp(
  [
    'no (information|memory|data|record)',
    'not (mentioned|available|enough|specified|provided)',
    "(do not|don't) know",
    'cannot (determine|find|answer)',
    'unclear',
    'insufficient',
    'unable to',
  ].join('|'),
  'i',
);

@Injectable()
export class AgentQaService {
  private readonly logger = new Logger(AgentQaService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxRounds: number;
  private readonly searchLimit: number;
  private readonly maxFactsPerRound: number;

  // DI fan-in: the V2 tool set needs substrate + embedder access
  // alongside the search stack.
  // eslint-disable-next-line max-params
  constructor(
    private readonly search: SearchService,
    private readonly config: ConfigService,
    @Optional() private readonly surreal?: SurrealService,
    @Optional() private readonly embedder?: EmbedderService,
    @Optional() private readonly multiHop?: MultiHopService,
  ) {
    this.openai = createOpenAiClientOrThrow(config);
    this.model = config.get<string>(
      'AGENT_QA_MODEL',
      config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.maxRounds = positiveIntEnv(config.get<string>('AGENT_QA_MAX_ROUNDS'), 6);
    this.searchLimit = positiveIntEnv(
      config.get<string>('AGENT_QA_SEARCH_LIMIT'),
      12,
    );
    this.maxFactsPerRound = positiveIntEnv(
      config.get<string>('AGENT_QA_MAX_FACTS_PER_ROUND'),
      40,
    );
  }

  async answer(input: AgentQaInput): Promise<AgentQaResult> {
    return withSpan(
      'agent_qa.answer',
      () => this.route(input),
      { 'agent_qa.max_rounds': this.maxRounds },
    );
  }

  /**
   * Escalation routing (memory-rebuild R3b). Measured on LoCoMo: the
   * loop REPLACING one-shot loses −4.6pp (over-searching easy
   * questions), while one-shot's failures cluster in hedged/uncited
   * answers — so the loop runs ONLY when the one-shot answer is null,
   * hedging, or citation-free. AGENT_QA_ROUTE_MODE=escalate; any other
   * value keeps the pure loop (measurement mode).
   */
  private async route(input: AgentQaInput): Promise<AgentQaResult> {
    const escalate =
      (process.env.AGENT_QA_ROUTE_MODE ?? '').trim() === 'escalate';
    if (!escalate || !this.multiHop) return this.runLoop(input);
    try {
      const oneShot = await this.multiHop.run({
        companyId: input.companyId,
        dto: {
          query: input.question,
          synthesize: true,
          synthesisGuardrails: 'answer',
          ...(input.asOf ? { asOf: input.asOf } : {}),
        } as never,
        callerScopes: input.callerScopes,
      });
      const answer = oneShot.synthesis?.answer?.trim() ?? '';
      const cited = (oneShot.synthesis?.citations ?? []).length > 0;
      if (answer && cited && !HEDGE.test(answer)) {
        return { answer, rounds: 0, queries: [], escalated: false };
      }
    } catch (e) {
      this.logger.warn(
        `one-shot leg failed, escalating to loop: ${(e as Error).message}`,
      );
    }
    const loop = await this.runLoop(input);
    return { ...loop, escalated: true };
  }

  private async runLoop(input: AgentQaInput): Promise<AgentQaResult> {
    const v2 = envFlagEnabled(process.env.AGENT_QA_TOOLS_V2);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: v2 ? SYSTEM_PROMPT_V2 : SYSTEM_PROMPT },
      { role: 'user', content: input.question },
    ];
    const queries: string[] = [];
    // Masked retrieval (V2): fact ids already shown this question are
    // never re-rendered, forcing each search to surface NEW evidence.
    const seenFactIds = new Set<string>();

    for (let round = 0; round < this.maxRounds; round++) {
      const res = await this.openai.chat.completions.create(
        {
          model: this.model,
          messages,
          tools: v2 ? [SEARCH_TOOL, TIMELINE_TOOL, GREP_TOOL] : [SEARCH_TOOL],
          tool_choice: 'auto',
          temperature: 0,
        },
        { signal: getAbortSignal() },
      );
      const msg = res.choices[0]?.message;
      if (!msg) break;

      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const call of msg.tool_calls) {
          // Only the function tool exists on this loop; ignore any other
          // tool-call variant the SDK union permits.
          if (call.type !== 'function') continue;
          const query = this.parseQuery(call.function.arguments);
          queries.push(query);
          const rendered = await this.dispatchTool({
            input,
            name: call.function.name,
            query,
            mask: v2 ? seenFactIds : undefined,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: rendered,
          });
        }
        continue;
      }

      // No tool call → the model produced its final answer.
      return { answer: (msg.content ?? '').trim(), rounds: round, queries };
    }

    // Round cap reached — force a concrete answer with tools disabled.
    const forced = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Give your single best short answer now, based only on what you already found. Do not search again. Never refuse.',
          },
        ],
        temperature: 0,
      },
      { signal: getAbortSignal() },
    );
    return {
      answer: (forced.choices[0]?.message?.content ?? '').trim(),
      rounds: this.maxRounds,
      queries,
    };
  }

  private parseQuery(argsJson: string): string {
    try {
      const args = JSON.parse(argsJson) as {
        query?: unknown;
        topic?: unknown;
        pattern?: unknown;
      };
      for (const v of [args.query, args.topic, args.pattern]) {
        if (typeof v === 'string' && v.trim()) return v;
      }
      return '';
    } catch {
      return '';
    }
  }

  private async dispatchTool({
    input,
    name,
    query,
    mask,
  }: {
    input: AgentQaInput;
    name: string;
    query: string;
    mask?: Set<string>;
  }): Promise<string> {
    if (name === 'timeline') return this.runTimeline(input, query);
    if (name === 'grep_episodes') return this.runGrep(input, query);
    return this.runSearch(input, query, mask);
  }

  private async runSearch(
    input: AgentQaInput,
    query: string,
    mask?: Set<string>,
  ): Promise<string> {
    if (!query.trim()) return 'No query provided.';
    try {
      const { results } = await this.search.search(
        input.companyId,
        { query, limit: this.searchLimit, asOf: input.asOf } as never,
        input.callerScopes,
      );
      const lines: string[] = [];
      for (const r of results) {
        for (const f of r.facts) {
          if (mask?.has(f.factId)) continue;
          mask?.add(f.factId);
          const date = f.validFrom ? ` (${String(f.validFrom).slice(0, 10)})` : '';
          lines.push(`[${r.canonicalName}] ${f.predicate}: ${f.object}${date}`);
        }
      }
      const facts = lines.slice(0, this.maxFactsPerRound);
      if (facts.length === 0) {
        return mask
          ? 'No NEW facts for that query — everything matching was already shown. Try a different angle or another tool.'
          : 'No facts found for that query.';
      }
      return facts.join('\n');
    } catch (e) {
      this.logger.warn(`agent-qa search failed: ${(e as Error).message}`);
      return `Search error: ${(e as Error).message}`;
    }
  }

  /**
   * Chronological enumerator (V2): topic-similar facts of the pinned
   * derived world, oldest-first — collection and counting instead of
   * top-k similarity sampling.
   */
  private async runTimeline(
    input: AgentQaInput,
    topic: string,
  ): Promise<string> {
    if (!topic.trim()) return 'No topic provided.';
    if (!this.surreal || !this.embedder) return 'Timeline unavailable.';
    try {
      const vec = await this.embedder.embed(topic);
      const version = process.env.RETRIEVAL_DERIVED_VERSION?.trim();
      const versionClause = version
        ? 'AND derivedVersion = $dv'
        : 'AND derivedVersion IS NONE';
      const rows = await this.surreal.withCompany(
        input.companyId,
        async (db) => {
          const [r] = await db.query<
            [Array<{ predicate: string; object: string; validFrom?: unknown }>]
          >(
            `SELECT predicate, object, validFrom,
                    vector::similarity::cosine(embedding, $q) AS score
               FROM knowledge_fact
              WHERE status = 'active' AND embedding != NONE ${versionClause}
              ORDER BY score DESC
              LIMIT 40`,
            { q: vec, dv: version },
          );
          return r ?? [];
        },
      );
      if (rows.length === 0) return 'No facts found for that topic.';
      return rows
        .slice()
        .sort(
          (a, b) =>
            new Date(String(a.validFrom ?? 0)).getTime() -
            new Date(String(b.validFrom ?? 0)).getTime(),
        )
        .map(
          (f) =>
            `[${String(f.validFrom ?? '').slice(0, 10) || 'undated'}] ${f.predicate}: ${f.object}`,
        )
        .join('\n');
    } catch (e) {
      this.logger.warn(`agent-qa timeline failed: ${(e as Error).message}`);
      return `Timeline error: ${(e as Error).message}`;
    }
  }

  /** Literal transcript search (V2), PII-gated like the read lanes. */
  private async runGrep(input: AgentQaInput, pattern: string): Promise<string> {
    if (!pattern.trim()) return 'No pattern provided.';
    if (!this.surreal) return 'Transcript search unavailable.';
    const piiGate = input.callerScopes.includes('brain:read_pii')
      ? ''
      : 'AND piiClass IS NONE';
    try {
      const rows = await this.surreal.withCompany(
        input.companyId,
        async (db) => {
          const [r] = await db.query<
            [
              Array<{
                speaker?: string;
                text: string;
                occurredAt: unknown;
              }>,
            ]
          >(
            `SELECT speaker, text, occurredAt, search::score(1) AS score
               FROM episode
              WHERE text @1@ $q ${piiGate}
              ORDER BY score DESC
              LIMIT 10`,
            { q: pattern },
          );
          return r ?? [];
        },
      );
      if (rows.length === 0) return 'No transcript turns match.';
      return rows
        .slice()
        .sort(
          (a, b) =>
            new Date(String(a.occurredAt)).getTime() -
            new Date(String(b.occurredAt)).getTime(),
        )
        .map(
          (t) =>
            `[${String(t.occurredAt).slice(0, 10)}] ${t.speaker ?? 'unknown'}: ${t.text}`,
        )
        .join('\n');
    } catch (e) {
      this.logger.warn(`agent-qa grep failed: ${(e as Error).message}`);
      return `Transcript search error: ${(e as Error).message}`;
    }
  }
}
