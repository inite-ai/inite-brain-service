import { ConfigService } from '@nestjs/config';
import { AgentQaService } from '../src/agent-qa/agent-qa.service';
import { EpisodeReadStoreService } from '../src/episodes/episode-read-store.service';
import type { SearchService } from '../src/search/search.service';

/**
 * AgentQaService — the ReAct loop. Stubs OpenAI (no network) and
 * SearchService. Pins: it issues tool-call search rounds, feeds results
 * back, and returns the model's final answer when it stops calling tools.
 */
describe('AgentQaService', () => {
  function cfg(env: Record<string, string> = {}): ConfigService {
    return {
      get: <T>(k: string, d?: T) => (env[k] ?? d) as T,
      getOrThrow: <T>(k: string) => (env[k] ?? 'sk-stub') as unknown as T,
    } as unknown as ConfigService;
  }

  function search(results: unknown): SearchService {
    return { search: async () => ({ results }) } as unknown as SearchService;
  }

  // Scripted OpenAI: first reply issues a search tool call, second reply is
  // the final answer. Records how many completions ran.
  function stubOpenAi(replies: any[]): { client: any; calls: () => number } {
    let i = 0;
    const client = {
      chat: {
        completions: {
          create: async () => replies[Math.min(i++, replies.length - 1)],
        },
      },
    };
    return { client, calls: () => i };
  }

  const toolCallReply = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 't1',
              type: 'function',
              function: {
                name: 'search_memory',
                arguments: JSON.stringify({ query: 'Caroline identity' }),
              },
            },
          ],
        },
      },
    ],
  };
  const finalReply = {
    choices: [{ message: { role: 'assistant', content: 'Transgender woman' } }],
  };

  it('runs a search round then returns the final answer', async () => {
    const svc = new AgentQaService(
      search([
        {
          canonicalName: 'Caroline',
          facts: [
            {
              predicate: 'preference',
              object: 'my journey as a transgender woman',
              validFrom: '2023-05-07T00:00:00Z',
            },
          ],
        },
      ]),
      cfg(),
    );
    const stub = stubOpenAi([toolCallReply, finalReply]);
    (svc as any).openai = stub.client;

    const out = await svc.answer({
      companyId: 'co_x',
      question: 'What is Caroline’s identity?',
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Transgender woman');
    expect(out.rounds).toBe(1);
    expect(out.queries).toEqual(['Caroline identity']);
    // one tool round + one final = two completions
    expect(stub.calls()).toBe(2);
  });

  it('returns immediately when the model answers without searching', async () => {
    const svc = new AgentQaService(search([]), cfg());
    (svc as any).openai = stubOpenAi([finalReply]).client;
    const out = await svc.answer({
      companyId: 'co_x',
      question: 'q',
      callerScopes: ['brain:read'],
    });
    expect(out.answer).toBe('Transgender woman');
    expect(out.rounds).toBe(0);
    expect(out.queries).toEqual([]);
  });

  describe('V2 tool set (AGENT_QA_TOOLS_V2)', () => {
    const saved = process.env.AGENT_QA_TOOLS_V2;
    afterEach(() => {
      if (saved === undefined) delete process.env.AGENT_QA_TOOLS_V2;
      else process.env.AGENT_QA_TOOLS_V2 = saved;
      delete process.env.RETRIEVAL_DERIVED_VERSION;
    });

    const factRow = {
      canonicalName: 'Caroline',
      facts: [
        {
          factId: 'knowledge_fact:f1',
          predicate: 'pets',
          object: 'cats Luna and Oliver',
          validFrom: '2023-05-07T00:00:00Z',
        },
      ],
    };
    const searchCall = (id: string) => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  name: 'search_memory',
                  arguments: JSON.stringify({ query: 'pets' }),
                },
              },
            ],
          },
        },
      ],
    });

    it('masks facts already shown across search rounds', async () => {
      process.env.AGENT_QA_TOOLS_V2 = '1';
      const toolMsgs: string[] = [];
      const svc = new AgentQaService(search([factRow]), cfg());
      let i = 0;
      (svc as any).openai = {
        chat: {
          completions: {
            create: async (req: any) => {
              // Capture tool results fed back into the transcript.
              for (const m of req.messages) if (m.role === 'tool') toolMsgs.push(m.content);
              const replies = [searchCall('t1'), searchCall('t2'), finalReply];
              return replies[Math.min(i++, 2)];
            },
          },
        },
      };
      const out = await svc.answer({
        companyId: 'co_x',
        question: 'What pets?',
        callerScopes: ['brain:read'],
      });
      expect(out.answer).toBe('Transgender woman');
      const unique = [...new Set(toolMsgs)];
      // Round 1 renders the fact; round 2 must NOT repeat it.
      expect(unique.some((m) => m.includes('Luna and Oliver'))).toBe(true);
      expect(unique.some((m) => m.includes('No NEW facts'))).toBe(true);
    });

    it('timeline tool renders chronological facts of the pinned world', async () => {
      process.env.AGENT_QA_TOOLS_V2 = '1';
      process.env.RETRIEVAL_DERIVED_VERSION = 'wd-v2';
      const queries: Array<{
        sql: string;
        params?: Record<string, unknown> | undefined;
      }> = [];
      const surreal = {
        withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string, params?: Record<string, unknown>) => {
              queries.push({ sql, params });
              return [
                [
                  {
                    predicate: 'activities',
                    object: 'later hike',
                    validFrom: '2023-08-01T00:00:00Z',
                  },
                  {
                    predicate: 'activities',
                    object: 'first hike',
                    validFrom: '2023-02-01T00:00:00Z',
                  },
                ],
              ];
            },
          }),
      };
      const embedder = { embed: async () => [1, 0] };
      const svc = new AgentQaService(search([]), cfg(), surreal as never, embedder as never);
      const timelineCall = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: {
                    name: 'timeline',
                    arguments: JSON.stringify({ topic: 'hiking' }),
                  },
                },
              ],
            },
          },
        ],
      };
      const toolMsgs: string[] = [];
      let i = 0;
      (svc as any).openai = {
        chat: {
          completions: {
            create: async (req: any) => {
              for (const m of req.messages) if (m.role === 'tool') toolMsgs.push(m.content);
              return [timelineCall, finalReply][Math.min(i++, 1)];
            },
          },
        },
      };
      await svc.answer({
        companyId: 'co_x',
        question: 'How many hikes?',
        callerScopes: ['brain:read'],
      });
      expect(queries[0]!.sql).toContain('derivedVersion = $dv');
      expect(queries[0]!.params?.dv).toBe('wd-v2');
      const rendered = toolMsgs.find((m) => m.includes('hike'));
      // Chronological: first hike before later hike.
      expect(rendered!.indexOf('first hike')).toBeLessThan(rendered!.indexOf('later hike'));
    });

    it('grep tool searches transcript BM25 with PII gate', async () => {
      process.env.AGENT_QA_TOOLS_V2 = '1';
      const queries: Array<{ sql: string }> = [];
      const surreal = {
        withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string) => {
              queries.push({ sql });
              return [
                [
                  {
                    speaker: 'Mel',
                    text: 'Matt Patterson sang',
                    occurredAt: '2023-06-01T00:00:00Z',
                  },
                ],
              ];
            },
          }),
      };
      const svc = new AgentQaService(
        search([]),
        cfg(),
        surreal as never,
        undefined,
        undefined,
        new EpisodeReadStoreService(surreal as never),
      );
      const grepCall = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: {
                    name: 'grep_episodes',
                    arguments: JSON.stringify({ pattern: 'Patterson' }),
                  },
                },
              ],
            },
          },
        ],
      };
      const toolMsgs: string[] = [];
      let i = 0;
      (svc as any).openai = {
        chat: {
          completions: {
            create: async (req: any) => {
              for (const m of req.messages) if (m.role === 'tool') toolMsgs.push(m.content);
              return [grepCall, finalReply][Math.min(i++, 1)];
            },
          },
        },
      };
      await svc.answer({
        companyId: 'co_x',
        question: 'Who performed?',
        callerScopes: ['brain:read'],
      });
      expect(queries[0]!.sql).toContain('@1@');
      expect(queries[0]!.sql).toContain('piiClass IS NONE');
      expect(toolMsgs.some((m) => m.includes('Matt Patterson sang'))).toBe(true);
    });

    it('escalate mode keeps a confident cited one-shot answer (no loop)', async () => {
      process.env.AGENT_QA_ROUTE_MODE = 'escalate';
      const multiHop = {
        run: async () => ({
          synthesis: {
            answer: 'Luna and Oliver',
            citations: [{ factId: 'knowledge_fact:f1' }],
          },
        }),
      };
      const svc = new AgentQaService(search([]), cfg(), undefined, undefined, multiHop as never);
      let llmCalls = 0;
      (svc as any).openai = {
        chat: {
          completions: {
            create: async () => {
              llmCalls += 1;
              return finalReply;
            },
          },
        },
      };
      const out = await svc.answer({
        companyId: 'co_x',
        question: 'What pets?',
        callerScopes: ['brain:read'],
      });
      expect(out.answer).toBe('Luna and Oliver');
      expect(out.escalated).toBe(false);
      expect(llmCalls).toBe(0);
      delete process.env.AGENT_QA_ROUTE_MODE;
    });

    it('escalate mode runs the loop on hedging or uncited answers', async () => {
      process.env.AGENT_QA_ROUTE_MODE = 'escalate';
      for (const synthesis of [
        { answer: 'There is no information about pets.', citations: [{ f: 1 }] },
        { answer: 'Luna', citations: [] },
        { answer: null, citations: [] },
      ]) {
        const multiHop = { run: async () => ({ synthesis }) };
        const svc = new AgentQaService(search([]), cfg(), undefined, undefined, multiHop as never);
        (svc as any).openai = stubOpenAi([finalReply]).client;
        const out = await svc.answer({
          companyId: 'co_x',
          question: 'What pets?',
          callerScopes: ['brain:read'],
        });
        expect(out.answer).toBe('Transgender woman');
        expect(out.escalated).toBe(true);
      }
      delete process.env.AGENT_QA_ROUTE_MODE;
    });

    it('flag off keeps the single-tool loop', async () => {
      delete process.env.AGENT_QA_TOOLS_V2;
      const svc = new AgentQaService(search([]), cfg());
      let tools: unknown[] = [];
      (svc as any).openai = {
        chat: {
          completions: {
            create: async (req: any) => {
              tools = req.tools;
              return finalReply;
            },
          },
        },
      };
      await svc.answer({
        companyId: 'co_x',
        question: 'q',
        callerScopes: ['brain:read'],
      });
      expect(tools).toHaveLength(1);
    });
  });
});
