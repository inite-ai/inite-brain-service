/**
 * Bridge wiring for @inite/brain-mcp — the downstream (harness-facing)
 * MCP server, the request passthroughs, and the sampling
 * reverse-passthrough. Split out of index.ts so the wiring can be
 * imported by tests without executing the CLI entrypoint.
 *
 * Surface map (v0.2.0):
 *   harness → bridge → brain:  tools/list, tools/call, resources/list,
 *                              resources/templates/list, resources/read
 *   brain → bridge → harness:  sampling/createMessage
 *
 * Everything is forwarded verbatim — no curation, no renaming, no field
 * filtering. The bridge advertises downstream exactly the capabilities
 * the upstream brain advertised (tools always; resources when brain has
 * them), and advertises `sampling` upstream so brain's
 * summarize_entity(styleHint='client_llm') can reach the harness's LLM.
 * If the harness itself never advertised sampling, the forwarded request
 * fails with a clear MCP error and brain falls back to its local
 * template — the same behavior as before the bridge supported sampling.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CreateMessageRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

export interface BridgeServerOptions {
  /** Connected upstream client (brain over Streamable HTTP + Bearer). */
  upstream: Client;
  /** Capabilities the upstream advertised during initialize. */
  upstreamCapabilities: ServerCapabilities;
  /** Downstream server identity shown to the harness. */
  name: string;
  version: string;
}

/**
 * Mirror of the upstream capabilities the bridge re-advertises to the
 * harness: tools always (brain's baseline surface), resources only when
 * the upstream actually has them — the MCP SDK rejects registering a
 * resources handler on a server that never declared the capability, so
 * the mirror and the handler set must agree.
 *
 * NOT mirrored: `sampling` is a client-side capability (it belongs in
 * the bridge's upstream initialize, not here), and server capabilities
 * brain doesn't advertise (prompts, logging) stay un-mirrored so the
 * bridge never promises what the upstream can't serve.
 */
export function downstreamCapabilities(upstream: ServerCapabilities): ServerCapabilities {
  return {
    tools: upstream.tools ?? {},
    ...(upstream.resources !== undefined ? { resources: upstream.resources } : {}),
  };
}

/**
 * Build the harness-facing stdio server: transparent passthrough of the
 * tool surface, plus the resource surface when the upstream advertises
 * one (brain exposes brain://entity/{id} and .../timeline as resource
 * TEMPLATES, so resources/templates/list is the discovery call that
 * makes them visible; resources/list stays a passthrough for
 * completeness and future concrete resources). Pagination cursors and
 * request params are forwarded verbatim in both directions.
 */
export function createBridgeServer({
  upstream,
  upstreamCapabilities,
  name,
  version,
}: BridgeServerOptions): Server {
  const capabilities = downstreamCapabilities(upstreamCapabilities);
  const server = new Server({ name, version }, { capabilities });

  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    upstream.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool(request.params),
  );

  if (capabilities.resources !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
      upstream.listResources(request.params),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
      upstream.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      upstream.readResource(request.params),
    );
  }

  return server;
}

/**
 * Reverse passthrough: brain (upstream server) may request
 * sampling/createMessage from its client — that client is this bridge,
 * so the request is forwarded DOWN to the harness, whose LLM answers.
 * The upstream Client must have been constructed with
 * `capabilities: { sampling: {} }` for this handler to register (the
 * SDK asserts declared capabilities), and because MCP has no capability
 * renegotiation the bridge advertises sampling upstream BEFORE it can
 * know whether the harness supports it. When the harness never
 * advertised sampling, the forwarded request fails with a clear MCP
 * error; brain catches sampling errors and falls back to its local
 * template, which is exactly the pre-bridge behavior.
 */
export function registerSamplingPassthrough({
  upstream,
  server,
  log = () => undefined,
}: {
  upstream: Client;
  server: Server;
  log?: (...args: unknown[]) => void;
}): void {
  upstream.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const clientCapabilities = server.getClientCapabilities();
    if (!clientCapabilities?.sampling) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'downstream harness does not advertise sampling — brain will fall back to its local template',
      );
    }
    log('forwarding sampling/createMessage to the downstream harness');
    return server.createMessage(request.params);
  });
}
