import { isAnonymousJsonRpc } from '../src/mcp/anonymous-jsonrpc';
import { PUBLIC_TOOL_NAMES } from '../src/mcp/public-tools';
import { McpOptionalAuthGuard } from '../src/mcp/mcp-optional-auth.guard';
import type { ApiKeyGuard } from '../src/auth/api-key.guard';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';

/**
 * The anonymous MCP surface, and the line it must not cross.
 *
 * Every JSON-RPC path used to sit behind ApiKeyGuard — `initialize` and
 * `tools/list` included — so a client that found this server in the MCP
 * registry could not learn what it does without completing OAuth first.
 * The 401 it received is a correct auth challenge, not a fault; the
 * problem is that the server could not say a word before it.
 *
 * Opening that door has exactly one dangerous failure mode, and it is
 * not "an anonymous caller reads memory" — the public server registers
 * no tool that can reach a tenant. It is the OPPOSITE: if everything
 * answered anonymously, an OAuth client would never see the 401 that
 * tells it where to authenticate, and onboarding would break for every
 * client that works today. So the gated methods must keep their
 * challenge, unchanged, and that is what most of this file pins.
 */
describe('which JSON-RPC messages may be served without a key', () => {
  it.each([['initialize'], ['notifications/initialized'], ['ping'], ['tools/list']])(
    'allows %s — it carries no tenant data',
    (method) => {
      expect(isAnonymousJsonRpc({ jsonrpc: '2.0', id: 1, method })).toBe(true);
    },
  );

  it.each(PUBLIC_TOOL_NAMES)('allows tools/call for the consultation tool %s', (name) => {
    expect(isAnonymousJsonRpc({ method: 'tools/call', params: { name } })).toBe(true);
  });

  it.each([
    ['search_knowledge'],
    ['ingest_fact'],
    ['get_entity_profile'],
    ['synthesize_answer'],
    ['rename_workspace'],
  ])('refuses tools/call for %s — memory needs a credential', (name) => {
    expect(isAnonymousJsonRpc({ method: 'tools/call', params: { name } })).toBe(false);
  });

  it('refuses a tools/call with no name rather than defaulting open', () => {
    expect(isAnonymousJsonRpc({ method: 'tools/call' })).toBe(false);
    expect(isAnonymousJsonRpc({ method: 'tools/call', params: {} })).toBe(false);
    expect(isAnonymousJsonRpc({ method: 'tools/call', params: { name: 42 } })).toBe(false);
  });

  it('refuses anything shapeless — a body it cannot read is not a pass', () => {
    for (const body of [undefined, null, 'initialize', 7, {}, { method: 9 }, []]) {
      expect(isAnonymousJsonRpc(body)).toBe(false);
    }
  });

  it('a BATCH is anonymous only if every message is', () => {
    const pub = { method: 'tools/call', params: { name: 'about_brain' } };
    expect(isAnonymousJsonRpc([{ method: 'initialize' }, pub])).toBe(true);
    // One gated call makes the whole batch gated: a memory read must not
    // ride in behind an initialize.
    expect(
      isAnonymousJsonRpc([
        { method: 'initialize' },
        { method: 'tools/call', params: { name: 'search_knowledge' } },
      ]),
    ).toBe(false);
  });
});

describe('the optional-auth guard', () => {
  const ctx = (body: unknown): ExecutionContext => {
    const req: Record<string, unknown> = { body };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  };
  const guardWith = (inner: Partial<ApiKeyGuard>): McpOptionalAuthGuard =>
    new McpOptionalAuthGuard(inner as ApiKeyGuard);

  it('an authenticated request is never marked anonymous', async () => {
    const c = ctx({ method: 'initialize' });
    const g = guardWith({ canActivate: async () => true });
    await expect(g.canActivate(c)).resolves.toBe(true);
    const req = c.switchToHttp().getRequest<{ mcpAnonymous?: boolean }>();
    // Explicitly false, not merely absent: a later edit must not be able
    // to read an authenticated request as an anonymous one.
    expect(req.mcpAnonymous).toBe(false);
  });

  it('RE-THROWS the auth error for a gated call — the 401 carries the challenge', async () => {
    const boom = new UnauthorizedException('Missing or malformed Authorization header');
    const g = guardWith({
      canActivate: async () => {
        throw boom;
      },
    });
    await expect(
      g.canActivate(ctx({ method: 'tools/call', params: { name: 'search_knowledge' } })),
    ).rejects.toBe(boom);
  });

  it('lets an unauthenticated initialize through, marked anonymous', async () => {
    const c = ctx({ method: 'initialize' });
    const g = guardWith({
      canActivate: async () => {
        throw new UnauthorizedException('no key');
      },
    });
    await expect(g.canActivate(c)).resolves.toBe(true);
    expect(c.switchToHttp().getRequest<{ mcpAnonymous?: boolean }>().mcpAnonymous).toBe(true);
  });

  it('a guard that returns false without throwing is still a refusal', async () => {
    const g = guardWith({ canActivate: async () => false });
    await expect(
      g.canActivate(ctx({ method: 'tools/call', params: { name: 'ingest_fact' } })),
    ).resolves.toBe(false);
  });
});
