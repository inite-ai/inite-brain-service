import {
  All,
  BadRequestException,
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { POLICY_ACTION_EXEMPT } from '../policy/policy-gate.service';
import { McpService } from './mcp.service';
import { profileParam, resolveToolProfile } from './tool-profiles';
import { AuthenticatedRequest } from '../auth/api-key.types';

@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  /**
   * Unauthenticated health probe. Returns {ok, version, tools[]} —
   * the read-baseline tool surface, so a setup script can verify the
   * MCP endpoint is reachable BEFORE the operator pastes the API key.
   *
   * Intentionally no `companyId` validation here either — a probe
   * from a misconfigured client should get a structured response,
   * not 400. The full handler retains the `pathCompanyId === auth.
   * companyId` invariant.
   *
   * We don't reveal tools gated on brain:write or brain:admin —
   * downstream operators can confirm those exist by hitting the
   * authenticated MCP endpoint with the right scope.
   */
  // Both spellings answer: `/mcp/health` is what a client that only knows
  // the tenant-less URL can reach, `/mcp/:companyId/health` what the
  // per-tenant URL gives. Declared first so the single-segment form is
  // not swallowed by `@All(':companyId')` below.
  @Get('health')
  healthRoot(@Req() req: Request): ReturnType<McpService['health']> {
    // No tenant on this spelling, so no per-tenant overlay to apply —
    // the probe answers for the URL parameter and the process default.
    return this.mcp.health(resolveToolProfile(profileParam(req.query as Record<string, unknown>)));
  }

  @Get(':companyId/health')
  health(
    @Req() req: Request,
    @Param('companyId') pathCompanyId: string,
  ): ReturnType<McpService['health']> {
    // Unauthenticated, so the tenant here is whatever the caller typed.
    // It selects a PROFILE and nothing else — no data is read — so an
    // invented companyId can only mis-report a tool list to its author.
    return this.mcp.health(
      resolveToolProfile(profileParam(req.query as Record<string, unknown>), pathCompanyId),
    );
  }

  /**
   * Tenant-less MCP endpoint: the tenant comes from the credential.
   *
   * The per-tenant URL below cannot be the only spelling. A client that
   * discovers this server through OAuth knows one thing — the URL it was
   * given — and learns the tenant only after the token is issued, from
   * the `org` claim. Requiring the tenant in the path made every
   * one-click connector flow (Claude custom connectors, ChatGPT) a
   * non-starter, and made every copy-paste config need a value the
   * product had no way to hand out at that moment.
   *
   * There is no weaker check here than on the path form: that route
   * compares the path against the credential's tenant, and this one
   * simply takes the credential's tenant. Neither lets a caller choose.
   */
  @Throttle({ expensive: { limit: 30, ttl: 60_000 } })
  @All()
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction(POLICY_ACTION_EXEMPT)
  async handleForCredentialTenant(
    @Req() req: AuthenticatedRequest & Request,
    @Res() res: Response,
  ) {
    await this.serve(req, res);
  }

  /**
   * Per-tenant MCP Streamable HTTP endpoint.
   *
   * Security invariant from spec: companyId in URL path MUST match the
   * companyId on the ApiKey. Mismatch is 400.
   *
   * Stateless mode: each POST creates a fresh server + transport pair,
   * processes the JSON-RPC message, and tears down. No session state.
   * MCP clients that need long-running sessions should call once per
   * tool use; stateful sessions can be added later via sessionIdGenerator.
   */
  // MCP tools (search_knowledge, ingest_fact, …) reach the same
  // OpenAI-fanout paths that the REST controllers cap via the
  // `expensive` bucket. Without this the MCP route was a throttle
  // bypass at the 120/min default. Use a per-route expensive override
  // (30/min) rather than the global 10: a single stateless tool use is
  // several JSON-RPC POSTs (initialize / tools/list / tools/call), and
  // the handshake messages don't fan out to OpenAI — 30 leaves headroom
  // for them while still capping the OpenAI-bound calls well below 120.
  // Exempt from the ABAC action gate: gating the transport would deny
  // the whole JSON-RPC surface (initialize, tools/list) on any
  // default-deny key. Individual tools are gated inside buildServer —
  // denied tools vanish from tools/list and their handlers never bind.
  @Throttle({ expensive: { limit: 30, ttl: 60_000 } })
  @All(':companyId')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction(POLICY_ACTION_EXEMPT)
  async handle(
    @Req() req: AuthenticatedRequest & Request,
    @Res() res: Response,
    @Param('companyId') pathCompanyId: string,
  ) {
    const auth = req.brainAuth;
    if (pathCompanyId !== auth.companyId) {
      throw new BadRequestException(
        `MCP path companyId (${pathCompanyId}) does not match ApiKey companyId`,
      );
    }
    await this.serve(req, res);
  }

  /** The transport, once, for both spellings of the endpoint. */
  private async serve(req: AuthenticatedRequest & Request, res: Response): Promise<void> {
    const auth = req.brainAuth;
    const server = await this.mcp.buildServer(auth.companyId, auth.scopes, {
      actorKeyHash: auth.keyHash,
      policy: auth.policy,
      packIds: auth.packIds,
      actorId: auth.actorId,
      mcpGrantedActions: auth.mcpGrantedActions,
      userId: auth.userId,
      // `?tools=core` on the URL. The URL is the only field a one-click
      // connector ever hands the user, so it is where this has to live;
      // an unknown value is a 400 from resolveToolProfile rather than a
      // silent fall back to the full surface.
      toolProfile: resolveToolProfile(
        profileParam(req.query as Record<string, unknown>),
        auth.companyId,
      ),
    });
    // Stateless mode: omitting sessionIdGenerator entirely reads the same
    // as an explicit `undefined` (the SDK just stores whatever the key
    // holds — absent and `undefined` are indistinguishable at that read),
    // and exactOptionalPropertyTypes forbids writing the literal undefined.
    const transport = new StreamableHTTPServerTransport({});

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    // Bridge a self-inconsistency in @modelcontextprotocol/sdk's own .d.ts
    // that surfaces under exactOptionalPropertyTypes: the Transport interface
    // declares `onclose?/onerror?/onmessage?: () => void` (optional) while
    // StreamableHTTPServerTransport implements them as accessors typed
    // `(() => void) | undefined`, so the concrete class no longer structurally
    // satisfies its own interface. The runtime value genuinely is a valid
    // Transport; this asserts the SDK's own contract, not our types.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, req.body);
  }
}
