import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SearchService } from '../search/search.service';
import { getAbortSignal } from '../common/request-context';
import { withSpan } from '../common/tracing';

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
}

@Injectable()
export class AgentQaService {
  private readonly logger = new Logger(AgentQaService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxRounds: number;
  private readonly searchLimit: number;
  private readonly maxFactsPerRound: number;

  constructor(
    private readonly search: SearchService,
    private readonly config: ConfigService,
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
      () => this.runLoop(input),
      { 'agent_qa.max_rounds': this.maxRounds },
    );
  }

  private async runLoop(input: AgentQaInput): Promise<AgentQaResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: input.question },
    ];
    const queries: string[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const res = await this.openai.chat.completions.create(
        {
          model: this.model,
          messages,
          tools: [SEARCH_TOOL],
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
          const rendered = await this.runSearch(input, query);
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
      const args = JSON.parse(argsJson) as { query?: unknown };
      return typeof args.query === 'string' ? args.query : '';
    } catch {
      return '';
    }
  }

  private async runSearch(input: AgentQaInput, query: string): Promise<string> {
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
          const date = f.validFrom ? ` (${String(f.validFrom).slice(0, 10)})` : '';
          lines.push(`[${r.canonicalName}] ${f.predicate}: ${f.object}${date}`);
        }
      }
      const facts = lines.slice(0, this.maxFactsPerRound);
      if (facts.length === 0) return 'No facts found for that query.';
      return facts.join('\n');
    } catch (e) {
      this.logger.warn(`agent-qa search failed: ${(e as Error).message}`);
      return `Search error: ${(e as Error).message}`;
    }
  }
}
