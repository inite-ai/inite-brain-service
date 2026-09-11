import { z } from 'zod';
import type { Brain } from './client.js';

/**
 * Brain as framework tools.
 *
 * The shape returned here — `{ description, inputSchema, execute }` — is
 * what the Vercel AI SDK's `tools:` map takes, and it is also what the
 * OpenAI Agents SDK and Mastra accept with a one-line wrap. That is why
 * this package depends on zod and on nothing else: a zod schema plus an
 * async function is the common denominator of every JS agent framework
 * worth adapting to, so one object serves all of them and none of them
 * gets to be a dependency.
 *
 *   import { generateText } from 'ai'
 *   import { createBrain, brainTools } from '@inite/brain'
 *
 *   const brain = createBrain({ apiKey: process.env.BRAIN_KEY!, userId })
 *   await generateText({ model, tools: brainTools(brain), prompt })
 *
 * Four tools, not fourteen. Every tool in the list costs context on
 * every turn whether or not it is called, and an agent that can search,
 * answer, write and read history can do the work; the rest of brain's
 * surface is one MCP connection away when it is actually needed.
 */

export interface BrainTool {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: never) => Promise<unknown>;
}

export function brainTools(brain: Brain): Record<string, BrainTool> {
  return {
    recall_memory: {
      description:
        'Search long-term memory for what is known about a person, project or topic. Returns ' +
        'matching entities with the facts recorded about them, each with the window it is true ' +
        'for. Use this before answering anything that depends on history the conversation does ' +
        'not contain.',
      inputSchema: z.object({
        query: z.string().describe('What you are looking for, in natural language'),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ query, limit }: { query: string; limit?: number }) => {
        const hits = await brain.recall(query, limit === undefined ? {} : { limit });
        return hits.map((hit) => ({
          entityId: hit.entityId,
          name: hit.canonicalName,
          facts: hit.facts.map((f) => ({
            statement: `${f.predicate} ${f.object}`,
            from: f.validFrom,
            until: f.validUntil,
            status: f.status,
          })),
        }));
      },
    },

    answer_from_memory: {
      description:
        'Ask memory a question and get a written answer with citations back to the facts that ' +
        'support it, instead of a ranked list to read yourself. Slower and more expensive than ' +
        'recall_memory — use it when the answer needs synthesis across several facts.',
      inputSchema: z.object({
        question: z.string().describe('The question, in natural language'),
      }),
      execute: ({ question }: { question: string }) => brain.answer(question),
    },

    remember: {
      description:
        'Store something in long-term memory. Pass the text as it was said or written; memory ' +
        'extracts the entities and claims itself and resolves them against what it already ' +
        'knows, so a contradiction becomes a superseded fact rather than a duplicate. Use it ' +
        'for anything that should outlive this conversation.',
      inputSchema: z.object({
        text: z.string().max(16_000).describe('What to remember, in plain language'),
      }),
      execute: async ({ text }: { text: string }) => {
        const out = await brain.remember(text);
        return out.skipped
          ? { stored: false, reason: out.reason ?? 'nothing worth recording' }
          : { stored: true, facts: out.extractedFactIds.length };
      },
    },

    memory_history: {
      description:
        'The full history of one entity — every fact ever recorded about it, including the ones ' +
        'that have since been superseded or retracted, with the dates that separate them. Use ' +
        'this for "what did we think before", "when did that change", and anything where the ' +
        'current value is not the whole answer. Takes an entityId from recall_memory.',
      inputSchema: z.object({
        entityId: z.string().describe('entityId, exactly as recall_memory returned it'),
        since: z.string().optional().describe('ISO-8601 lower bound'),
      }),
      execute: ({ entityId, since }: { entityId: string; since?: string }) =>
        brain.timeline(entityId, since === undefined ? {} : { since }),
    },
  };
}
