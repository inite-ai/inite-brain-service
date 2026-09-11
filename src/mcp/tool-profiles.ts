import { BadRequestException } from '@nestjs/common';

/**
 * Tool profiles — how much of the surface a connection sees.
 *
 * A read-only key exposes 20 tools today; read + write + admin reaches
 * 32, before any pack adds its own. Their descriptions and JSON schemas
 * land in `tools/list` and are then resident in the model's context for
 * the whole session, whether or not a single one is called. That is
 * several thousand tokens spent before the user has typed anything, and
 * it is spent on every request in a stateless server.
 *
 * The whole ecosystem moved the other way in 2026 — tool search,
 * progressive disclosure, code mode — and nothing here let an operator
 * say "give me the five tools I actually use". A profile is that knob.
 *
 * `full` is the default and stays byte-identical to the pre-profile
 * surface: no gate is applied at all, so a deployment that never sets
 * the parameter cannot be affected by this file.
 */

/** Tools a `core` connection lists. Everything else stays reachable through `run_tool`. */
const CORE_TOOLS = [
  // Find something.
  'search_knowledge',
  // Answer with citations.
  'synthesize',
  // What changed since I was last here.
  'memory_diff',
  // The history of one thing.
  'get_entity_timeline',
  // Write one claim.
  'record_fact',
  // Where am I connected, and what is set up.
  'workspace_status',
] as const;

/**
 * The two tools that make `core` a narrowing rather than a loss.
 * `find_tool` searches the full catalogue and returns real input
 * schemas; `run_tool` executes any of them. Both go through the same
 * policy, grant and scope gates as a direct call — see
 * McpService.applyToolProfile, which captures each handler AFTER those
 * wrappers are applied.
 */
export const META_TOOLS = ['find_tool', 'run_tool'] as const;

export type ToolProfileName = 'full' | 'core';

export interface ToolProfile {
  name: ToolProfileName;
  /** null = list everything (no gate). */
  listed: readonly string[] | null;
  /** Whether find_tool / run_tool are registered. */
  meta: boolean;
}

const PROFILES: Record<ToolProfileName, ToolProfile> = {
  full: { name: 'full', listed: null, meta: false },
  core: { name: 'core', listed: [...CORE_TOOLS, ...META_TOOLS], meta: true },
};

export const TOOL_PROFILE_NAMES = Object.keys(PROFILES) as ToolProfileName[];

const isProfileName = (value: string): value is ToolProfileName =>
  Object.prototype.hasOwnProperty.call(PROFILES, value);

/**
 * This tenant's profile from `MCP_TOOL_PROFILE_OVERRIDES`, following the
 * RETRIEVAL_PROFILE_OVERRIDES idiom: a JSON object mapping companyId →
 * profile name, read at CALL time so a change takes effect without a
 * restart, malformed entries failing open to the process default PER
 * TENANT rather than discarding the whole map.
 *
 * A tenant-level knob is the point: "which tools does my agent see" is a
 * per-workspace decision, and a process-global env would force every
 * tenant on a shared deployment onto one answer.
 */
export function toolProfileOverrideFor(
  companyId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!companyId) return undefined;
  const raw = env.MCP_TOOL_PROFILE_OVERRIDES;
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[companyId];
  if (typeof entry !== 'string') return undefined;
  const name = entry.trim().toLowerCase();
  // An unknown name in the overlay falls open to the process default:
  // one typo in one tenant's entry must not 400 that tenant's every
  // request, which is what throwing here would do.
  return isProfileName(name) ? name : undefined;
}

/**
 * Resolve the profile for one request.
 *
 * Precedence: the URL parameter the caller chose, then this tenant's
 * overlay, then the process default, then `full`. The URL is the only
 * knob a one-click connector user ever controls — the whole flow hands
 * them a single field to paste — so it has to win over configuration.
 *
 * An unrecognised name in the URL is a 400 rather than a silent
 * fallback: someone who asked for six tools and got thirty-two would
 * have no way to tell, and would pay the context cost they were trying
 * to avoid. An unrecognised name in the OVERLAY is not, because that
 * one is the operator's typo and the caller cannot fix it — see above.
 */
export function resolveToolProfile(
  requested?: string | undefined,
  companyId?: string | undefined,
): ToolProfile {
  const raw = (
    requested ??
    toolProfileOverrideFor(companyId) ??
    process.env.MCP_TOOL_PROFILE_DEFAULT ??
    'full'
  )
    .trim()
    .toLowerCase();
  if (!isProfileName(raw)) {
    throw new BadRequestException(
      `unknown tool profile '${raw}' (expected one of: ${TOOL_PROFILE_NAMES.join(', ')})`,
    );
  }
  return PROFILES[raw];
}

/**
 * The `?tools=` / `?profile=` parameter, whichever the client used.
 * Express gives repeated or bracketed parameters as arrays or objects;
 * anything that is not a single string is ignored rather than coerced,
 * so a malformed query cannot pick a profile by accident.
 */
export function profileParam(query: Record<string, unknown>): string | undefined {
  const value = query.tools ?? query.profile;
  return typeof value === 'string' ? value : undefined;
}
