#!/usr/bin/env -S npx ts-node -T
/**
 * mcp-schemas — the MCP tool input schemas, as a client sees them.
 *
 * Writes test/golden/mcp-tool-schemas.json: every tool name mapped to the
 * `inputSchema` that `tools/list` returns. test/mcp-tool-schemas.unit-spec.ts
 * compares the live surface against it and fails on a breaking delta (a
 * tool or property removed, a property newly required, a type narrowed, an
 * enum value removed), because those are what an agent's cached tool list
 * and an SDK's generated types code against.
 *
 * "As a client sees them" is literal: the schemas come from a real
 * `tools/list` over an in-memory MCP transport, against the server
 * McpService.buildServer assembles for one credential. Converting the zod
 * shapes ourselves would pin our own conversion, not the SDK's.
 *
 * The surface is the WIDEST one a deployment can serve, pinned so the
 * golden is the same on every machine:
 *   - every scope (brain:admin's forget, brain:read_media's read_media);
 *   - the `full` tool profile, whatever MCP_TOOL_PROFILE_DEFAULT says;
 *   - every env-switched family on (harness work tools, blob upload, raw
 *     media reads, facts API, document ingest), observation off;
 *   - an unnamed workspace (rename_workspace) and the relationship pack
 *     active (its tools are a pack's, but built in);
 *   - per-tenant pack tools OFF: they are each tenant's own declared
 *     surface, not brain's contract.
 *
 * Run: `pnpm mcp:schemas`.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpService } from '../src/mcp/mcp.service';
import { resolveToolProfile } from '../src/mcp/tool-profiles';
import type { BrainScope } from '../src/auth/api-key.types';

export const MCP_SCHEMA_GOLDEN_PATH = join(
  __dirname,
  '..',
  'test',
  'golden',
  'mcp-tool-schemas.json',
);

const ALL_SCOPES: BrainScope[] = [
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
  'brain:read_media',
  'brain:platform_admin',
];

/** The env every family-switch reads at registration time, pinned on. */
const PINNED_ENV: Record<string, string | undefined> = {
  EXTRACTION_SOURCE: 'harness',
  EVIDENCE_BLOB_UPLOAD_ENABLED: '1',
  EVIDENCE_RAW_READ_ENABLED: '1',
  FACTS_API_ENABLED: '1',
  DOCUMENT_INGEST_ENABLED: '1',
  TOOL_OBSERVATIONS_ENABLED: '0',
  MCP_PACK_TOOLS_ENABLED: '0',
  MCP_TOOL_PROFILE_DEFAULT: undefined,
};

function withPinnedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(PINNED_ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function fullSurfaceService(): McpService {
  const none = {} as never;
  const embedder = {
    cacheStats: () => ({ provider: 'set per workspace' }),
    getDimensions: () => 0,
  };
  const packToolsReader = { isActive: async () => true, installedPackTools: async () => [] };
  const workspaceStatus = { isNamed: async () => false };
  return new McpService(
    none, // search
    none, // entities
    none, // ingest
    none, // facts
    none, // multiHop
    none, // synth
    none, // memoryDiff
    none, // predictor
    none, // summarizer
    none, // procedural
    none, // communities
    none, // codeSearch
    none, // sources
    embedder as never,
    none, // documents — present, so ingest_document registers
    none, // feedback — present, so record_feedback registers
    none, // policyGate — no policy context, never consulted
    packToolsReader as never,
    none, // packToolProxy
    undefined, // metrics
    undefined, // toolObservations
    workspaceStatus as never,
  );
}

/** Tool name → the inputSchema `tools/list` returns, keys sorted by name. */
export async function liveToolSchemas(): Promise<Record<string, unknown>> {
  return withPinnedEnv(async () => {
    const server = await fullSurfaceService().buildServer('co_schema_golden', ALL_SCOPES, {
      toolProfile: resolveToolProfile('full'),
    });
    const client = new Client({ name: 'mcp-schemas', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const out: Record<string, unknown> = {};
      for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
        out[t.name] = t.inputSchema;
      }
      return out;
    } finally {
      await client.close();
      await server.close();
    }
  });
}

/** The golden's on-disk form: two-space JSON, trailing newline. */
export function serializeGolden(schemas: Record<string, unknown>): string {
  return `${JSON.stringify(schemas, null, 2)}\n`;
}

async function main(): Promise<void> {
  const schemas = await liveToolSchemas();
  writeFileSync(MCP_SCHEMA_GOLDEN_PATH, serializeGolden(schemas));
  console.log(`wrote ${Object.keys(schemas).length} tool schemas to ${MCP_SCHEMA_GOLDEN_PATH}`);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
