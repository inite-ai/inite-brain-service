/**
 * Phase 4.3 sampling — unit-level coverage of the capability gate +
 * fallback path. We don't drive a real MCP client here; we stub the
 * McpServer wrapper to control getClientCapabilities() and the
 * inner server.createMessage().
 */
import { summarizeViaClientSampling } from '../src/mcp/sampling';

interface FakeServer {
  server: {
    getClientCapabilities: () => { sampling?: object } | undefined;
    createMessage: (args: unknown) => Promise<{
      model: string;
      content: { type: 'text'; text: string };
      role: 'assistant';
    }>;
  };
}

function fakeServer(opts: {
  sampling: boolean;
  text?: string;
  shouldThrow?: boolean;
}): FakeServer {
  return {
    server: {
      getClientCapabilities: () => (opts.sampling ? { sampling: {} } : {}),
      createMessage: async () => {
        if (opts.shouldThrow) throw new Error('boom');
        return {
          model: 'fake-client-model-v1',
          role: 'assistant',
          content: { type: 'text', text: opts.text ?? 'A short briefing.' },
        };
      },
    },
  };
}

const fakeProfile = {
  entityId: 'knowledge_entity:test',
  type: 'customer',
  canonicalName: 'Test Subject',
  externalRefs: { rent: 'cust_test' },
  facts: [
    {
      factId: 'knowledge_fact:1',
      predicate: 'tier',
      object: 'platinum',
      confidence: 0.95,
      validFrom: '2026-01-01',
      status: 'active',
    },
  ],
};

const fakeFallbackResult = {
  entityId: 'knowledge_entity:test',
  summary: 'Test Subject (customer): tier=platinum.',
  factsConsidered: 1,
  style: 'neutral' as const,
  cached: false,
  asOf: undefined,
};

describe('summarizeViaClientSampling — capability gate + fallback', () => {
  const deps = {
    entities: {
      getProfile: async () => fakeProfile,
    } as never,
    summarizer: {
      summarize: async () => fakeFallbackResult,
    } as never,
  };

  it('client advertises sampling → returns client_llm summary', async () => {
    const server = fakeServer({ sampling: true, text: 'Platinum customer.' });
    const out = await summarizeViaClientSampling(
      deps,
      server as never,
      'co_test',
      'test_entity',
      undefined,
      ['brain:read'],
    );
    expect(out.sampledBy).toBe('client_llm');
    expect(out.summary).toBe('Platinum customer.');
    expect(out.modelUsed).toBe('fake-client-model-v1');
  });

  it('client does NOT advertise sampling → falls back to template', async () => {
    const server = fakeServer({ sampling: false });
    const out = await summarizeViaClientSampling(
      deps,
      server as never,
      'co_test',
      'test_entity',
      undefined,
      ['brain:read'],
    );
    expect(out.sampledBy).toBe('local_template');
    expect(out.summary).toBe('Test Subject (customer): tier=platinum.');
    expect(out.modelUsed).toBeUndefined();
  });

  it('createMessage throwing → falls back to template, no error to caller', async () => {
    const server = fakeServer({ sampling: true, shouldThrow: true });
    const out = await summarizeViaClientSampling(
      deps,
      server as never,
      'co_test',
      'test_entity',
      undefined,
      ['brain:read'],
    );
    expect(out.sampledBy).toBe('local_template');
  });

  it('empty client text → uses entity name + type as a safe default', async () => {
    const server = fakeServer({ sampling: true, text: '' });
    const out = await summarizeViaClientSampling(
      deps,
      server as never,
      'co_test',
      'test_entity',
      undefined,
      ['brain:read'],
    );
    expect(out.sampledBy).toBe('client_llm');
    expect(out.summary).toBe('Test Subject (customer)');
  });
});
