#!/usr/bin/env node
/**
 * @inite/brain-mcp — first-party stdio MCP connector for the INITE Brain.
 *
 * Why this exists: brain speaks MCP over **Streamable HTTP** with a Bearer
 * API key (`POST /mcp/:companyId`). Many harnesses (openclaw, hermes, Goose
 * 1.x, Aider, …) only know how to spawn **stdio** MCP servers as subprocesses
 * and have no way to attach an Authorization header. This binary bridges the
 * two: the harness spawns it over stdio, and it transparently proxies every
 * tool the key is scoped for to the remote brain.
 *
 *   harness ──stdio──▶ brain-mcp ──HTTP+Bearer──▶ https://brain.inite.ai/mcp/<company>
 *
 * It is a thin, transparent passthrough — it does NOT curate or rename tools.
 * `tools/list`, `tools/call`, and the resource surface (`resources/list`,
 * `resources/templates/list`, `resources/read` — brain://entity/… lives
 * there) are forwarded verbatim, so the harness sees exactly the surface
 * the API key unlocks (read / write / admin). Sampling is bridged the
 * other way: brain's sampling/createMessage requests are forwarded to the
 * harness so summarize_entity(styleHint='client_llm') can use ITS model.
 * See bridge.ts for the wiring.
 *
 * Config is entirely via environment (harnesses pass `env` to the subprocess):
 *   BRAIN_API_KEY      (required)  e.g. brain_xxxxx
 *   BRAIN_COMPANY_ID   (required unless BRAIN_MCP_URL is set)
 *   BRAIN_BASE_URL     (optional)  default https://brain.inite.ai
 *   BRAIN_MCP_URL      (optional)  full endpoint override; wins over BASE_URL+COMPANY_ID
 *
 * Everything logs to stderr — stdout is the MCP wire and must stay clean.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeServer, registerSamplingPassthrough } from './bridge.js';

const PKG_NAME = '@inite/brain-mcp';
const PKG_VERSION = '0.2.0';
const DEFAULT_BASE_URL = 'https://brain.inite.ai';
const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Log to stderr only — stdout is the JSON-RPC channel. */
function log(...args: unknown[]): void {
  console.error(`[brain-mcp]`, ...args);
}

function fail(message: string): never {
  log(`error: ${message}`);
  process.exit(1);
}

interface Resolved {
  url: string;
  apiKey: string;
}

function resolveConfig(): Resolved {
  const apiKey = (process.env.BRAIN_API_KEY ?? '').trim();
  if (!apiKey) {
    fail(
      'BRAIN_API_KEY is required. Get one at https://brain.inite.ai/admin/keys ' +
        'and pass it via the harness `env` for this server.',
    );
  }

  const explicit = (process.env.BRAIN_MCP_URL ?? '').trim();
  if (explicit) {
    try {
      // Validate shape early so failures are obvious, not buried in a fetch.
      new URL(explicit);
    } catch {
      fail(`BRAIN_MCP_URL is not a valid URL: ${explicit}`);
    }
    return { url: explicit, apiKey };
  }

  const companyId = (process.env.BRAIN_COMPANY_ID ?? '').trim();
  if (!companyId) {
    fail(
      'BRAIN_COMPANY_ID is required (or set BRAIN_MCP_URL to the full endpoint). ' +
        'Your companyId is shown at https://brain.inite.ai/admin/keys.',
    );
  }
  if (!COMPANY_ID_RE.test(companyId)) {
    fail(
      `BRAIN_COMPANY_ID "${companyId}" is malformed — expected [A-Za-z0-9_-]{1,64}.`,
    );
  }

  const baseUrl = (process.env.BRAIN_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  return { url: `${baseUrl}/mcp/${companyId}`, apiKey };
}

async function connectUpstream({ url, apiKey }: Resolved): Promise<Client> {
  // `sampling` is declared upstream unconditionally: MCP has no
  // capability renegotiation, and the harness's own capabilities are
  // only known after the stdio side connects (which needs the upstream
  // capabilities first, to mirror them). If the harness turns out not
  // to support sampling, the forwarded request errors cleanly and brain
  // falls back to its local template — see registerSamplingPassthrough.
  const client = new Client(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { sampling: {} } },
  );

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  try {
    await client.connect(transport);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(
      `could not reach brain at ${url} — ${detail}\n` +
        '  check: is the URL/companyId right, is the API key valid, ' +
        'does the key match this companyId?',
    );
  }

  return client;
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  log(`${PKG_NAME} v${PKG_VERSION} → ${cfg.url}`);

  const upstream = await connectUpstream(cfg);

  // Mirror whatever the upstream advertises so the harness's view matches
  // the key's scope (tools appear/disappear based on read/write/admin).
  const upstreamCaps = upstream.getServerCapabilities() ?? {};
  const upstreamInfo = upstream.getServerVersion();
  log(
    `connected to ${upstreamInfo?.name ?? 'brain'} ` +
      `v${upstreamInfo?.version ?? '?'} ` +
      `(capabilities: ${Object.keys(upstreamCaps).join(', ') || 'none'})`,
  );

  // Downstream server faces the harness over stdio. It advertises the
  // capabilities the upstream actually has (tools + resources) and
  // forwards every surface verbatim, including pagination cursors.
  const server = createBridgeServer({
    upstream,
    upstreamCapabilities: upstreamCaps,
    name: 'brain',
    version: upstreamInfo?.version ?? PKG_VERSION,
  });

  // Reverse direction: brain's sampling/createMessage requests reach the
  // harness's LLM (summarize_entity styleHint='client_llm').
  registerSamplingPassthrough({ upstream, server, log });

  // If the remote connection drops, take the bridge down so the harness
  // surfaces it instead of silently serving a dead proxy.
  upstream.onclose = () => {
    log('upstream connection closed — exiting');
    process.exit(1);
  };

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  log('ready — proxying brain tools over stdio');

  const shutdown = (signal: string) => {
    log(`received ${signal} — shutting down`);
    void server.close();
    void upstream.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  fail(`fatal: ${detail}`);
});
