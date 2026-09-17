#!/usr/bin/env node
/**
 * brain-agent — the INITE Brain local agent (docs/source-plane.md § Agent).
 *
 *   BRAIN_URL=https://brain.example BRAIN_API_KEY=… brain-agent sync
 *   brain-agent sync --agent laptop-1 --every 15      # keep syncing every 15 minutes
 *   brain-agent sync --connection source_connection:… --full
 *   brain-agent list                                   # what this agent is asked to sync
 *
 * An operator points connections at this agent (Admin → Connections,
 * host `agent:<id>`); the agent asks the brain which ones, walks the
 * folders / repositories / stdio MCP servers on THIS machine, and posts
 * what changed. The key is a tenant WRITE key (brain:write) — never an
 * admin one.
 *
 * Flags:
 *   --agent <id>        this agent's id (default: BRAIN_AGENT_ID, else the hostname)
 *   --connection <id>   sync one connection instead of all
 *   --full              re-walk everything; what the walk does not see is gone
 *   --every <minutes>   keep running, one pass per interval
 *   --no-redact         send text without the local secret redaction
 *   --json              machine-readable summaries on stdout
 * Env:
 *   BRAIN_URL, BRAIN_API_KEY, BRAIN_AGENT_ID, BRAIN_AGENT_ROOTS (':'-separated
 *   allowlist for fs roots when the agent serves others)
 */
import { hostname } from 'node:os';
import { FsAgentConnector } from './connectors/fs.js';
import { GitAgentConnector } from './connectors/git.js';
import { McpStdioAgentConnector } from './connectors/mcp-stdio.js';
import { BrainAgentClient } from './protocol.js';
import { connectorFor, runConnection } from './runner.js';
import type { AgentConnector, SyncSummary } from './types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  process.stderr.write(`brain-agent: ${msg}\n`);
  process.exit(1);
}

function agentId(): string {
  const raw = arg('agent') ?? process.env.BRAIN_AGENT_ID ?? hostname().split('.')[0] ?? 'agent';
  const id = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z0-9]/.test(id)) fail(`agent id "${raw}" must start with a letter or digit`);
  return id;
}

function client(): BrainAgentClient {
  const baseUrl = process.env.BRAIN_URL;
  const apiKey = process.env.BRAIN_API_KEY;
  if (!baseUrl) fail('BRAIN_URL is not set');
  if (!apiKey) fail('BRAIN_API_KEY is not set');
  return new BrainAgentClient({ baseUrl, apiKey });
}

function registry(): AgentConnector[] {
  const roots = (process.env.BRAIN_AGENT_ROOTS ?? '').split(':').map((r) => r.trim()).filter(Boolean);
  return [new FsAgentConnector(roots), new GitAgentConnector(), new McpStdioAgentConnector()];
}

async function pass(id: string, only: string | undefined, json: boolean): Promise<SyncSummary[]> {
  const brain = client();
  const connectors = registry();
  const targets = (await brain.listConnections(id)).filter((t) => !only || t.connection.id === only);
  if (targets.length === 0) {
    process.stderr.write(`brain-agent: no ${only ? `connection ${only}` : 'connections'} pointed at agent:${id}\n`);
    return [];
  }
  const out: SyncSummary[] = [];
  for (const target of targets) {
    if (target.connection.status !== 'active') continue;
    const label = target.connection.label ?? `${target.connection.packId}/${target.connection.sourceId}`;
    let connector: AgentConnector;
    try {
      connector = connectorFor(connectors, target);
    } catch (e) {
      process.stderr.write(`brain-agent: skip ${label}: ${(e as Error).message}\n`);
      continue;
    }
    const summary = await runConnection(brain, connector, target, {
      agentId: id,
      full: flag('full'),
      redact: !flag('no-redact'),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    out.push(summary);
    if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else {
      process.stdout.write(
        `${label}: ${summary.status} (${summary.mode}) seen=${summary.seen} new=${summary.new} changed=${summary.changed} gone=${summary.gone} fetched=${summary.fetched} ingested=${summary.ingested} dedup=${summary.deduplicated} failed=${summary.failed} closed=${summary.closed} in ${summary.durationMs}ms${summary.error ? ` — ${summary.error}` : ''}\n`,
      );
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const id = agentId();
  if (cmd === 'list') {
    const targets = await client().listConnections(id);
    if (flag('json')) process.stdout.write(`${JSON.stringify(targets)}\n`);
    else {
      for (const t of targets) {
        const c = t.connection;
        process.stdout.write(`${c.id}  ${c.status}  ${c.packId}/${c.sourceId}  ${c.connector}·${c.shape}  ${c.label ?? ''}\n`);
      }
      if (targets.length === 0) process.stdout.write(`(nothing pointed at agent:${id})\n`);
    }
    return;
  }
  if (cmd !== 'sync') {
    process.stderr.write('usage: brain-agent <sync|list> [--agent <id>] [--connection <id>] [--full] [--every <min>] [--no-redact] [--json]\n');
    process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 1);
  }
  const every = arg('every') ? Number(arg('every')) : 0;
  for (;;) {
    const summaries = await pass(id, arg('connection'), flag('json'));
    if (!(every > 0)) {
      process.exit(summaries.some((s) => s.status === 'failed') ? 2 : 0);
    }
    await new Promise((r) => setTimeout(r, every * 60_000));
  }
}

main().catch((e: unknown) => fail((e as Error).message));
