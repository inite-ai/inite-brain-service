/**
 * Wrapper-ordering semantics for the 0111 tool-observation recorder on
 * the MCP surface. buildServer patches registerTool in this order:
 * wrapToolErrors → policy gate → grant gate → applyToolObservation —
 * and earlier-applied is OUTERMOST at call time, so the observation
 * wrapper is INNERMOST:
 *   * a policy-denied call throws in the gate BEFORE the observation
 *     wrapper runs ⇒ no record;
 *   * durationMs times the raw handler only;
 *   * a thrown handler error is recorded ok:false and rethrown, so the
 *     outer wrapToolErrors still shapes the client-facing error;
 *   * flag off at build ⇒ the wrapper is never applied (byte-identical).
 * Exercised through the same private-method patch sequence buildServer
 * runs, over a fake McpServer (the _registeredTools inspection idiom).
 */
import { ForbiddenException } from '@nestjs/common';
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ToolObservationInput,
  ToolObservationService,
} from '../src/outcomes/tool-observation.service';
import { digestPayload } from '../src/common/payload-digest';

type Handler = (...args: unknown[]) => unknown;

function fakeServer(handlers: Record<string, Handler>): McpServer {
  return {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
      return { remove: () => delete handlers[name] };
    },
  } as unknown as McpServer;
}

const recorded: Array<{ companyId: string; input: ToolObservationInput }> = [];
const stubRecorder = {
  enabled: () => true,
  record: (companyId: string, input: ToolObservationInput) => {
    recorded.push({ companyId, input });
  },
} as unknown as ToolObservationService;

let policyAllows = true;
const stubPolicyGate = {
  enforceToolAction: () => {
    if (!policyAllows) throw new ForbiddenException('denied by policy');
  },
};

function svcWith(recorder?: ToolObservationService): McpService {
  return new McpService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    stubPolicyGate as never,
    {} as never,
    {} as never,
    undefined, // metrics
    recorder as never,
  );
}

/** Apply the exact buildServer patch sequence, then register one tool. */
function buildPatched(handler: Handler): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = fakeServer(handlers);
  const svc = svcWith(stubRecorder) as unknown as {
    wrapToolErrors(s: McpServer): void;
    applyPolicyToolGate(s: McpServer, policy: unknown): void;
    applyToolObservation(s: McpServer, companyId: string): void;
  };
  svc.wrapToolErrors(server);
  svc.applyPolicyToolGate(server, {
    companyId: 'co_obs',
    keyHash: 'sha256:test',
    sets: [],
    forceReportOnly: false,
    resolutionError: false,
  } as never);
  svc.applyToolObservation(server, 'co_obs');
  server.registerTool('probe_tool' as never, {} as never, handler as never);
  return handlers;
}

describe('MCP tool-observation wrapper ordering', () => {
  beforeEach(() => {
    recorded.length = 0;
    policyAllows = true;
  });

  it('records one content-free row for an allowed successful call', async () => {
    const handlers = buildPatched(async (args: unknown) => ({
      content: [{ type: 'text', text: `echo ${JSON.stringify(args)}` }],
    }));
    await handlers['probe_tool']!({ q: 'secret-query' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.companyId).toBe('co_obs');
    const input = recorded[0]!.input;
    expect(input.tool).toBe('probe_tool');
    expect(input.ok).toBe(true);
    expect(input.durationMs).toBeGreaterThanOrEqual(0);
    // The wrapper hands RAW args/result to the recorder, which digests
    // them — same digest the storage row will carry.
    expect(digestPayload(input.args)).toBe(digestPayload({ q: 'secret-query' }));
  });

  it('a policy-denied call produces NO record (observation is inside the gate)', async () => {
    policyAllows = false;
    const handlers = buildPatched(async () => ({ content: [] }));
    // ForbiddenException (<500) passes through wrapToolErrors unchanged.
    await expect(handlers['probe_tool']!({})).rejects.toBeInstanceOf(ForbiddenException);
    expect(recorded).toEqual([]);
  });

  it('a thrown handler error is recorded ok:false and the client shape survives', async () => {
    const handlers = buildPatched(async () => {
      throw new Error('handler exploded: raw db detail');
    });
    // Rethrown by the observation wrapper, then shaped by the outer
    // wrapToolErrors into the generic isError result — never raw.
    const out = (await handlers['probe_tool']!({})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('internal error while running probe_tool');
    expect(out.content[0]!.text).not.toContain('raw db detail');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input.ok).toBe(false);
  });

  it('an isError tool result records ok:false', async () => {
    const handlers = buildPatched(async () => ({ content: [], isError: true }));
    await handlers['probe_tool']!({});
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input.ok).toBe(false);
  });

  it('no recorder injected ⇒ wrapper is a no-op patch (fixtures stay valid)', async () => {
    const handlers: Record<string, Handler> = {};
    const server = fakeServer(handlers);
    const svc = svcWith(undefined) as unknown as {
      applyToolObservation(s: McpServer, companyId: string): void;
    };
    svc.applyToolObservation(server, 'co_obs');
    server.registerTool(
      'probe_tool' as never,
      {} as never,
      (async () => ({
        content: [],
      })) as never,
    );
    await handlers['probe_tool']!({});
    expect(recorded).toEqual([]);
  });

  it('buildServer applies the wrapper only under the master flag', async () => {
    const applied: string[] = [];
    const proto = McpService.prototype as unknown as Record<string, unknown>;
    const original = proto.applyToolObservation;
    proto.applyToolObservation = function (...args: unknown[]) {
      applied.push('yes');
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    try {
      const stubEmbedder = {
        cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
        getDimensions: () => 1536,
      };
      const stubReader = { installedPackTools: async () => [] };
      const build = () =>
        new McpService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          stubEmbedder as never,
          {} as never,
          {} as never,
          stubPolicyGate as never,
          stubReader as never,
          {} as never,
          undefined,
          stubRecorder as never,
        ).buildServer('co_obs', []);
      delete process.env.TOOL_OBSERVATIONS_ENABLED;
      await build();
      expect(applied).toEqual([]);
      process.env.TOOL_OBSERVATIONS_ENABLED = '1';
      await build();
      expect(applied).toEqual(['yes']);
    } finally {
      proto.applyToolObservation = original;
      delete process.env.TOOL_OBSERVATIONS_ENABLED;
    }
  });
});
