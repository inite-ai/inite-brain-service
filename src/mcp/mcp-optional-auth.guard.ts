import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { isAnonymousJsonRpc } from './anonymous-jsonrpc';

/**
 * Auth for the MCP transport, with one narrow opening.
 *
 * Delegates to ApiKeyGuard for everything. When that refuses — no key,
 * bad key, expired key — this asks one more question: was the message
 * one an anonymous caller may have? `initialize`, `tools/list`, `ping`
 * and the two consultation tools are; anything touching memory is not,
 * and its refusal is re-thrown UNCHANGED, so the 401 keeps the
 * `WWW-Authenticate` header an OAuth client needs to start its flow.
 *
 * WHY A WRAPPER rather than a flag inside ApiKeyGuard: that guard fences
 * every authenticated surface in the service, and a boolean inside it
 * that sometimes lets an unauthenticated request through is one edit
 * away from doing so on a route nobody was thinking about. Here the
 * opening exists only on the route that mounts this guard, and it grants
 * nothing by itself — the handler still has to choose the public server,
 * which registers no tool that can reach a tenant.
 *
 * `req.mcpAnonymous` is the handler's signal. It is set ONLY on this
 * path and never when ApiKeyGuard succeeded, so an authenticated request
 * can never be downgraded into the public surface by a later edit.
 */
@Injectable()
export class McpOptionalAuthGuard implements CanActivate {
  constructor(private readonly apiKey: ApiKeyGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      mcpAnonymous?: boolean;
    }>();
    try {
      const ok = await this.apiKey.canActivate(context);
      if (ok) {
        request.mcpAnonymous = false;
        return true;
      }
      // A guard that returns false without throwing is a refusal too.
      if (!isAnonymousJsonRpc(request.body)) return false;
    } catch (err) {
      // Re-thrown unchanged for anything an anonymous caller may not
      // have: the 401 carries the auth challenge, and that challenge is
      // how an OAuth client learns where to authenticate.
      if (!isAnonymousJsonRpc(request.body)) throw err;
    }
    request.mcpAnonymous = true;
    return true;
  }
}
