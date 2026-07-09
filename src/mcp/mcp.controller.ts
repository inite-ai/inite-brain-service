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
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { McpService } from './mcp.service';
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
  @Get(':companyId/health')
  health(): {
    ok: boolean;
    version: string;
    tools: string[];
  } {
    return this.mcp.health();
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
  @Throttle({ expensive: { limit: 30, ttl: 60_000 } })
  @All(':companyId')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
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

    const server = this.mcp.buildServer(
      auth.companyId,
      auth.scopes,
      auth.keyHash,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, (req as any).body);
  }
}
