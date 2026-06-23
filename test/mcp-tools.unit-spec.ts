/**
 * Smoke coverage for the MCP tool-registration surface.
 *
 * Three things we pin:
 *
 * 1. Read-scope baseline — every read tool registers regardless of
 *    write/admin presence: search_knowledge, search_multi_hop,
 *    synthesize, get_entity_profile, get_entity_timeline,
 *    find_related_entities.
 *
 * 2. brain:write gate — record_fact, retract_fact, link_entities
 *    only register when the caller has brain:write. Without it, a
 *    caller can't drive any mutation from an agent loop.
 *
 * 3. brain:admin gate — forget_entity ONLY registers under
 *    brain:admin. GDPR cascade is irreversible; we don't want it on
 *    a key that only carries brain:write.
 *
 * Inspecting registrations: the SDK keeps tools in a private field
 * `_registeredTools` (a record keyed by tool name). We cast to read
 * it for the test only — production code never touches it.
 */
import { McpService } from '../src/mcp/mcp.service';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrainScope } from '../src/auth/api-key.types';

function buildWithScopes(scopes: BrainScope[]): McpServer {
  const svc = new McpService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return svc.buildServer('co_test', scopes);
}

function toolNames(server: McpServer): string[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(internals._registeredTools);
}

const READ_BASELINE = [
  'search_knowledge',
  'search_multi_hop',
  'synthesize',
  'get_entity_profile',
  'get_entity_timeline',
  'find_related_entities',
];

describe('McpService.buildServer — scope-gated tool surface', () => {
  it('registers the read baseline with only brain:read', () => {
    const names = toolNames(buildWithScopes(['brain:read']));
    for (const t of READ_BASELINE) expect(names).toContain(t);
  });

  it('does NOT register mutation tools without brain:write', () => {
    const names = toolNames(buildWithScopes(['brain:read']));
    expect(names).not.toContain('record_fact');
    expect(names).not.toContain('retract_fact');
    expect(names).not.toContain('link_entities');
  });

  it('registers mutation tools when brain:write is present', () => {
    const names = toolNames(buildWithScopes(['brain:read', 'brain:write']));
    expect(names).toContain('record_fact');
    expect(names).toContain('retract_fact');
    expect(names).toContain('link_entities');
  });

  it('does NOT register forget_entity without brain:admin (even with write)', () => {
    const names = toolNames(buildWithScopes(['brain:read', 'brain:write']));
    expect(names).not.toContain('forget_entity');
  });

  it('registers forget_entity only with brain:admin', () => {
    const names = toolNames(
      buildWithScopes(['brain:read', 'brain:write', 'brain:admin']),
    );
    expect(names).toContain('forget_entity');
  });
});
