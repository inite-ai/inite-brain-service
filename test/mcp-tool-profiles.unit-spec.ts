/**
 * Tool profiles and the meta pair that makes a narrow profile a
 * narrowing rather than a loss.
 *
 * The security question this spec exists to answer: does `run_tool`
 * dispatch through the same gates a direct `tools/call` goes through,
 * or is it a way around them? Every gate below is asserted on the
 * dispatch path, not just on the listing path.
 */
import { BadRequestException } from '@nestjs/common';
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  META_TOOLS,
  profileParam,
  resolveToolProfile,
  TOOL_PROFILE_NAMES,
} from '../src/mcp/tool-profiles';
import { compilePolicySet } from '../src/policy/policy-compile';
import { PolicyContext, PolicyDocument, PolicyDocumentSchema } from '../src/policy/policy.types';

const stubEmbedder = {
  cacheStats: () => ({ provider: 'openai:text-embedding-3-small' }),
  getDimensions: () => 1536,
};
const stubPackToolsReader = { installedPackTools: async () => [] };

interface EnforceCall {
  action: string;
}

// The workspace tool is part of the core profile, so the fixture has to
// supply the collaborator that registers it — otherwise `core` is seven
// tools and the assertion below would be measuring the fixture.
const stubWorkspaceStatus = {
  isNamed: async () => true,
  status: async () => ({ companyId: 'co_test' }),
  rename: async () => undefined,
};

function service(opts?: { enforce?: (action: string) => void; procedural?: unknown }): McpService {
  const stubPolicyGate = {
    enforceAction: () => undefined,
    enforceToolAction: (_policy: unknown, action: string) => opts?.enforce?.(action),
  };
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
    (opts?.procedural ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    stubEmbedder as never,
    {} as never,
    {} as never,
    stubPolicyGate as never,
    stubPackToolsReader as never,
    {} as never,
    undefined,
    undefined,
    stubWorkspaceStatus as never,
  );
}

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

const internals = (server: McpServer) =>
  (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

const toolNames = (server: McpServer): string[] => Object.keys(internals(server));

const call = (server: McpServer, name: string, args: unknown = {}) =>
  internals(server)[name]!.handler(args, {
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => undefined,
    sendRequest: async () => undefined,
  } as never);

const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

/** A policy that allows everything — enough to switch the gate on. */
function allowAll(): PolicyContext {
  const parsed: PolicyDocument = PolicyDocumentSchema.parse({
    name: 'allow-all',
    posture: { actions: 'allow', reads: 'allow' },
    mode: 'enforce',
    rules: [],
  });
  const compiled = compilePolicySet(parsed);
  if (!compiled) throw new Error('disabled set in test');
  return {
    companyId: 'co_test',
    keyHash: 'sha256:test',
    sets: [compiled],
    forceReportOnly: false,
    resolutionError: false,
  };
}

const build = (svc: McpService, profile?: string, extra?: { policy?: PolicyContext }) =>
  svc.buildServer('co_test', ['brain:read', 'brain:write', 'brain:admin'], {
    actorKeyHash: 'sha256:test',
    ...(profile ? { toolProfile: resolveToolProfile(profile) } : {}),
    ...extra,
  });

describe('resolveToolProfile', () => {
  const saved = process.env.MCP_TOOL_PROFILE_DEFAULT;
  afterEach(() => {
    if (saved === undefined) delete process.env.MCP_TOOL_PROFILE_DEFAULT;
    else process.env.MCP_TOOL_PROFILE_DEFAULT = saved;
  });

  it('defaults to the full surface, so an untouched deployment is unchanged', () => {
    delete process.env.MCP_TOOL_PROFILE_DEFAULT;
    const profile = resolveToolProfile();
    expect(profile.name).toBe('full');
    expect(profile.listed).toBeNull();
    expect(profile.meta).toBe(false);
  });

  it('lets the operator set the default', () => {
    process.env.MCP_TOOL_PROFILE_DEFAULT = 'core';
    expect(resolveToolProfile().name).toBe('core');
  });

  it('lets the URL win over the operator default', () => {
    // The URL is the only field a one-click connector hands the user.
    process.env.MCP_TOOL_PROFILE_DEFAULT = 'core';
    expect(resolveToolProfile('full').name).toBe('full');
  });

  it('rejects an unknown profile instead of quietly serving everything', () => {
    // Someone who asked for six tools and got thirty-two would have no
    // way to tell, and would pay the context cost they were avoiding.
    expect(() => resolveToolProfile('smol')).toThrow(BadRequestException);
    expect(() => resolveToolProfile('smol')).toThrow(/core/);
    expect(() => resolveToolProfile('smol')).toThrow(/chatgpt/);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveToolProfile('  CORE ').name).toBe('core');
  });

  it('names every profile it accepts', () => {
    expect(TOOL_PROFILE_NAMES.sort()).toEqual(['chatgpt', 'core', 'full']);
  });
});

describe('per-tenant overrides', () => {
  const savedDefault = process.env.MCP_TOOL_PROFILE_DEFAULT;
  const savedOverrides = process.env.MCP_TOOL_PROFILE_OVERRIDES;
  afterEach(() => {
    for (const [key, value] of [
      ['MCP_TOOL_PROFILE_DEFAULT', savedDefault],
      ['MCP_TOOL_PROFILE_OVERRIDES', savedOverrides],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('gives one tenant a different surface from the rest of the deployment', () => {
    // "Which tools does my agent see" is a per-workspace decision; a
    // process-global env would force every tenant onto one answer.
    delete process.env.MCP_TOOL_PROFILE_DEFAULT;
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'core' });
    expect(resolveToolProfile(undefined, 'co_acme').name).toBe('core');
    expect(resolveToolProfile(undefined, 'co_other').name).toBe('full');
  });

  it('is read on every call, so a change needs no restart', () => {
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'core' });
    expect(resolveToolProfile(undefined, 'co_acme').name).toBe('core');
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'full' });
    expect(resolveToolProfile(undefined, 'co_acme').name).toBe('full');
  });

  it('still lets the URL win', () => {
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'core' });
    expect(resolveToolProfile('full', 'co_acme').name).toBe('full');
  });

  it('beats the process default', () => {
    process.env.MCP_TOOL_PROFILE_DEFAULT = 'full';
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'core' });
    expect(resolveToolProfile(undefined, 'co_acme').name).toBe('core');
  });

  it.each([
    ['not json at all', 'core'],
    ['{"co_acme":"smol"}', 'core'],
    ['{"co_acme":42}', 'core'],
    ['["co_acme"]', 'core'],
    ['null', 'core'],
  ])('falls open to the process default when the overlay says %s', (overrides) => {
    // An operator typo in one tenant's entry must not 400 every request
    // that tenant makes — the caller has no way to fix it.
    process.env.MCP_TOOL_PROFILE_DEFAULT = 'core';
    process.env.MCP_TOOL_PROFILE_OVERRIDES = overrides;
    expect(resolveToolProfile(undefined, 'co_acme').name).toBe('core');
  });

  it('ignores the overlay entirely without a tenant', () => {
    delete process.env.MCP_TOOL_PROFILE_DEFAULT;
    process.env.MCP_TOOL_PROFILE_OVERRIDES = JSON.stringify({ co_acme: 'core' });
    expect(resolveToolProfile().name).toBe('full');
  });
});

describe('profileParam', () => {
  it('reads either spelling', () => {
    expect(profileParam({ tools: 'core' })).toBe('core');
    expect(profileParam({ profile: 'core' })).toBe('core');
  });

  it('ignores anything that is not a single string', () => {
    // Express turns ?tools=a&tools=b into an array and ?tools[x]=y into
    // an object; coercing either would let a malformed query pick a
    // profile by accident.
    expect(profileParam({ tools: ['core', 'full'] })).toBeUndefined();
    expect(profileParam({ tools: { x: 'core' } })).toBeUndefined();
    expect(profileParam({})).toBeUndefined();
  });
});

describe('the full profile', () => {
  it('is byte-identical to the pre-profile surface', async () => {
    const server = await build(service(), 'full');
    const names = toolNames(server);
    expect(names).toContain('search_knowledge');
    expect(names).toContain('get_competing_facts');
    expect(names).toContain('forget_entity');
    // No gate applied means no meta tools either.
    for (const meta of META_TOOLS) expect(names).not.toContain(meta);
    expect(names.length).toBeGreaterThan(25);
  });
});

describe('the core profile', () => {
  it('lists six tools plus the meta pair, and nothing else', async () => {
    const server = await build(service(), 'core');
    expect(toolNames(server).sort()).toEqual(
      [
        'find_tool',
        'get_entity_timeline',
        'memory_diff',
        'record_fact',
        'run_tool',
        'search_knowledge',
        'synthesize',
        'workspace_status',
      ].sort(),
    );
  });

  it('cuts the listed surface by roughly three quarters', async () => {
    const full = toolNames(await build(service(), 'full')).length;
    const core = toolNames(await build(service(), 'core')).length;
    expect(core).toBeLessThan(full / 3);
  });

  describe('find_tool', () => {
    it('finds an unlisted tool by name and hands back its real schema', async () => {
      const server = await build(service(), 'core');
      const out = JSON.parse(textOf(await call(server, 'find_tool', { query: 'competing facts' })));
      const names = out.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('get_competing_facts');
      const hit = out.tools.find((t: { name: string }) => t.name === 'get_competing_facts');
      expect(hit.arguments.type).toBe('object');
      expect(Object.keys(hit.arguments.properties).length).toBeGreaterThan(0);
    });

    it('never returns a tool the profile already lists', async () => {
      const server = await build(service(), 'core');
      const out = JSON.parse(textOf(await call(server, 'find_tool', { query: 'search' })));
      const names: string[] = out.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain('search_knowledge');
      expect(out.allToolNames).not.toContain('search_knowledge');
    });

    it('hands back the full name list even when nothing matches', async () => {
      // An empty result with no catalogue is a dead end for the model.
      const server = await build(service(), 'core');
      const out = JSON.parse(textOf(await call(server, 'find_tool', { query: 'zzzzzz' })));
      expect(out.tools).toHaveLength(0);
      expect(out.allToolNames.length).toBeGreaterThan(10);
    });
  });

  describe('run_tool', () => {
    it('dispatches to the real handler', async () => {
      const procedural = { list: async () => [{ id: 'p1', title: 'greet politely' }] };
      const server = await build(service({ procedural }), 'core');
      const out = await call(server, 'run_tool', { name: 'list_procedures', args: {} });
      expect(textOf(out)).toContain('greet politely');
    });

    it('runs the policy gate on the dispatch path, not only on listing', async () => {
      // The invariant this whole design rests on: the captured handler
      // is the fully-wrapped one, so dispatch cannot skip a check.
      const seen: EnforceCall[] = [];
      const procedural = { list: async () => [] };
      const svc = service({ procedural, enforce: (action) => seen.push({ action }) });
      const server = await build(svc, 'core', { policy: allowAll() });
      await call(server, 'run_tool', { name: 'list_procedures', args: {} });
      expect(seen.map((s) => s.action)).toContain('list_procedures');
    });

    it('refuses a tool the policy gate removed, without admitting it exists', async () => {
      const parsed: PolicyDocument = PolicyDocumentSchema.parse({
        name: 'no-procedures',
        posture: { actions: 'allow', reads: 'allow' },
        mode: 'enforce',
        rules: [{ id: 'np', effect: 'deny', kind: 'action', actions: ['list_procedures'] }],
      });
      const compiled = compilePolicySet(parsed);
      if (!compiled) throw new Error('disabled set in test');
      const policy: PolicyContext = {
        companyId: 'co_test',
        keyHash: 'sha256:test',
        sets: [compiled],
        forceReportOnly: false,
        resolutionError: false,
      };
      const server = await build(service({ procedural: { list: async () => [] } }), 'core', {
        policy,
      });
      const out = await call(server, 'run_tool', { name: 'list_procedures', args: {} });
      expect((out as { isError?: boolean }).isError).toBe(true);
      // Same wording as a name that never existed — a narrowed surface
      // that distinguishes them is an enumeration oracle.
      expect(textOf(out)).toContain("unknown tool 'list_procedures'");

      const found = JSON.parse(textOf(await call(server, 'find_tool', { query: 'procedures' })));
      expect(found.allToolNames).not.toContain('list_procedures');
    });

    it('answers the same way for a name that was never registered', async () => {
      const server = await build(service(), 'core');
      const out = await call(server, 'run_tool', { name: 'drop_database', args: {} });
      expect((out as { isError?: boolean }).isError).toBe(true);
      expect(textOf(out)).toContain("unknown tool 'drop_database'");
    });

    it('validates arguments, because dispatch bypasses the SDK that would', async () => {
      const server = await build(service({ procedural: { list: async () => [] } }), 'core');
      const out = await call(server, 'run_tool', {
        name: 'list_procedures',
        args: { limit: 'all of them' },
      });
      expect((out as { isError?: boolean }).isError).toBe(true);
      expect(textOf(out)).toContain('invalid arguments for list_procedures');
    });
  });
});

describe('the health probe', () => {
  it('answers for the profile it was asked about', () => {
    const svc = service();
    expect(svc.health(resolveToolProfile('full')).profile).toBe('full');
    const core = svc.health(resolveToolProfile('core'));
    expect(core.profile).toBe('core');
    // A setup script checking reachability must see the surface it is
    // about to get, not the one it would have got by default.
    expect(core.tools).toContain('search_knowledge');
    expect(core.tools).toContain('find_tool');
    expect(core.tools).not.toContain('get_competing_facts');
    expect(core.tools.length).toBeLessThan(svc.health(resolveToolProfile('full')).tools.length);
  });
});
