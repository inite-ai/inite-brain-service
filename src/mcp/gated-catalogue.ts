import { UnauthorizedException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrainScope } from '../auth/api-key.types';
import { registerCodeMemoryReadTools, registerCodeMemoryWriteTools } from './code-memory-tools';
import { registerCommunityTools } from './community-tools';
import { registerHarnessWorkTools } from './harness-work-tools';
import { registerMediaReadTools, registerMediaWriteTools } from './media-tools';
import { registerOnboardingTools } from './onboarding-tools';
import { registerProceduralReadTools } from './procedural-tools';
import { PUBLIC_TOOL_NAMES } from './public-tools';
import { registerReadTools } from './read-tools';
import { registerSourceReadTools } from './source-tools';
import { resolveToolProfile, type ToolProfile } from './tool-profiles';
import { registerAdminTools, registerWriteTools } from './write-tools';
import { extractionSource } from '../common/extraction-source';

/**
 * The memory tools, LISTED to an anonymous caller and callable by none.
 *
 * Lazy authentication only works if the client knows a protected tool
 * exists: Claude (and any spec-following client) starts sign-in when a
 * `tools/call` comes back as an HTTP 401, and it only makes that call
 * for a tool it saw in `tools/list`. An anonymous list holding nothing
 * but the two public tools meant no client ever called a memory tool,
 * never met the 401, and never signed in — the doorbell was wired to
 * nothing.
 *
 * So the anonymous list carries the same names, titles, descriptions
 * and schemas an OAuth-scoped caller (`brain:read` + `brain:write`, what
 * the challenge asks for) would see. The fence is unchanged and still
 * the absence of code: the handlers registered here are refusals that
 * hold no service, and McpOptionalAuthGuard answers any non-public
 * `tools/call` with the 401 challenge before a handler is reached at
 * all. These are the second line, not the first.
 *
 * Registration runs the real `register*` functions against a recorder
 * with no dependencies, so the catalogue cannot drift from the surface
 * it advertises: a new tool shows up here the day it is registered.
 */
const CATALOGUE_SCOPES: BrainScope[] = ['brain:read', 'brain:write'];

interface Recorded {
  name: string;
  config: Record<string, unknown>;
}

function recorder(into: Recorded[]): McpServer {
  const target = {
    registerTool: (name: string, config: Record<string, unknown>) => {
      into.push({ name, config });
      return { remove: () => undefined, enable: () => undefined, disable: () => undefined };
    },
  };
  // Anything else a register function touches (resources, prompts) is
  // not part of the tool catalogue: answer it with a no-op.
  return new Proxy(target, {
    get: (t, prop) =>
      prop in t
        ? (t as Record<string | symbol, unknown>)[prop]
        : () => ({ remove: () => undefined }),
  }) as unknown as McpServer;
}

function record(): Recorded[] {
  const out: Recorded[] = [];
  const server = recorder(out);
  const companyId = '';
  const scopes = CATALOGUE_SCOPES;
  const none = {} as never;
  // The one dependency read at registration rather than at call time: the
  // tenant's embedder, named in search_knowledge's description.
  registerReadTools({
    server,
    companyId,
    scopes,
    deps: { embedderDescription: () => 'set per workspace' } as never,
  });
  registerProceduralReadTools(server, companyId, { procedural: none, scopes });
  registerCommunityTools(server, companyId, { communities: none, scopes });
  registerMediaReadTools({ server, companyId, scopes, actorKeyHash: '', deps: {} });
  registerCodeMemoryReadTools({ server, companyId, scopes, deps: none });
  registerSourceReadTools({ server, companyId, deps: none });
  registerOnboardingTools({ server, ctx: { companyId, scopes, named: true }, deps: none });
  registerWriteTools({
    server,
    companyId,
    scopes,
    actorKeyHash: '',
    actorId: undefined,
    deps: none,
  });
  registerCodeMemoryWriteTools({ server, companyId, deps: none });
  registerMediaWriteTools({ server, companyId, deps: {} });
  registerHarnessWorkTools({ server, companyId, deps: {} });
  return out;
}

/**
 * The memory tools a signed-in connection of `profile` would list, as
 * refusals. The profile is the URL's `?tools=`: a connector set up with
 * `?tools=core` sees the core surface before sign-in as after it.
 */
export function registerGatedCatalogue(
  server: McpServer,
  profile: ToolProfile = resolveToolProfile(),
): void {
  const listed = profile.listed ? new Set(profile.listed) : null;
  for (const { name, config } of record()) {
    if (PUBLIC_TOOL_NAMES.includes(name)) continue;
    if (listed && !listed.has(name)) continue;
    server.registerTool(
      name,
      config as never,
      (() => {
        throw new UnauthorizedException(`${name} needs a signed-in brain account`);
      }) as never,
    );
  }
}

/**
 * The scope a tool needs beyond `brain:read` (which the endpoint itself
 * requires): `brain:write` for the write families, `brain:admin` for the
 * admin ones, null for everything else. Derived by recording the same
 * register functions buildServer gates on those scopes, so a new write
 * tool is classified the day it is registered. Cached per harness mode,
 * the one switch that changes which write tools exist.
 */
export function requiredScopeOf(name: string): BrainScope | null {
  const key = extractionSource();
  let map = scopeMaps.get(key);
  if (!map) {
    map = new Map();
    const write: Recorded[] = [];
    const ws = recorder(write);
    // Every dependency present: a family that registers a tool only when
    // its service is wired (record_feedback) must still be classified.
    const none = new Proxy({}, { get: () => ({}) }) as never;
    registerWriteTools({
      server: ws,
      companyId: '',
      scopes: CATALOGUE_SCOPES,
      actorKeyHash: '',
      actorId: undefined,
      deps: none,
    });
    registerCodeMemoryWriteTools({ server: ws, companyId: '', deps: none });
    registerMediaWriteTools({ server: ws, companyId: '', deps: {} });
    registerHarnessWorkTools({ server: ws, companyId: '', deps: {} });
    for (const r of write) map.set(r.name, 'brain:write');
    const admin: Recorded[] = [];
    registerAdminTools(recorder(admin), '', none);
    for (const r of admin) map.set(r.name, 'brain:admin');
    scopeMaps.set(key, map);
  }
  return map.get(name) ?? null;
}

const scopeMaps = new Map<string, Map<string, BrainScope>>();
