import { ConfigService } from '@nestjs/config';
import { AgentQaService } from '../src/agent-qa/agent-qa.service';
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
});
