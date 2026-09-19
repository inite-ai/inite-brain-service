#!/usr/bin/env node
/**
 * brain-agent — the INITE Brain local agent (docs/source-plane.md § Agent).
 *
 *   brain-agent install --url https://brain.example --key key_… --agent laptop-1
 *                                                     # save the config, start the service
 *   brain-agent status                                # is the service running, what is it syncing
 *   brain-agent doctor                                # config, key, roots, git — with verdicts
 *   brain-agent sync                                  # one pass now (also what the service runs)
 *   brain-agent sync --every 15                       # keep syncing every 15 minutes
 *   brain-agent list                                  # what this agent is asked to sync
 *   brain-agent db add crm postgres://ro@localhost/crm   # a database this agent may read (the DSN stays here)
 *   brain-agent db list | db remove <name>
 *   brain-agent uninstall [--purge]                   # stop and remove the service (and the config)
 *
 * An operator points connections at this agent (Admin → Connections,
 * "on a local agent", host `agent:<id>`); the agent asks the brain which
 * ones, walks the folders / repositories / stdio MCP servers on THIS
 * machine, and posts what changed. The key is a tenant WRITE key
 * (brain:write) — never an admin one. It lives in ONE file (mode 0600):
 * ~/.config/brain-agent/config.json; environment variables override it.
 *
 * Flags (sync / list):
 *   --agent <id>        this agent's id (default: the config, BRAIN_AGENT_ID, else the hostname)
 *   --connection <id>   sync one connection instead of all
 *   --full              re-walk everything; what the walk does not see is gone
 *   --every <minutes>   keep running, one pass per interval
 *   --no-redact         send text without the local secret redaction
 *   --json              machine-readable summaries on stdout
 * Flags (install):
 *   --url --key --agent --roots <a:b> --every <minutes> --no-redact --no-service
 * Env:
 *   BRAIN_URL, BRAIN_API_KEY, BRAIN_AGENT_ID, BRAIN_AGENT_ROOTS (':'-separated
 *   allowlist for fs roots when the agent serves others), BRAIN_AGENT_HOME,
 *   BRAIN_AGENT_DB_<NAME> (the DSN of database <name>, over the config file)
 */
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import {
  DATABASE_NAME,
  DEFAULT_EVERY_MINUTES,
  configMode,
  configPath,
  databaseEnvName,
  databaseNames,
  loadConfig,
  maskKey,
  removeConfig,
  resolveConfig,
  resolveDsn,
  saveConfig,
  type AgentConfig,
} from './config.js';
import { DbAgentConnector } from './connectors/db.js';
import { dialectOf } from './connectors/db-session.js';
import { FsAgentConnector } from './connectors/fs.js';
import { GitAgentConnector } from './connectors/git.js';
import { McpStdioAgentConnector } from './connectors/mcp-stdio.js';
import { doctor, worstVerdict } from './doctor.js';
import { inventory } from './inventory.js';
import { BrainAgentClient } from './protocol.js';
import { connectorFor, runConnection } from './runner.js';
import {
  defaultLogDir,
  installService,
  serviceStatus,
  tailLog,
  uninstallService,
  type ServiceStatus,
} from './service.js';
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

const cfg = resolveConfig();

function agentId(): string {
  const raw = arg('agent') ?? cfg.agentId ?? hostname().split('.')[0] ?? 'agent';
  const id = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z0-9]/.test(id)) fail(`agent id "${raw}" must start with a letter or digit`);
  return id;
}

function client(): BrainAgentClient {
  if (!cfg.url) fail('no brain url — run "brain-agent install --url … --key … --agent …" or set BRAIN_URL');
  if (!cfg.apiKey) fail('no key — run "brain-agent install" or set BRAIN_API_KEY');
  return new BrainAgentClient({ baseUrl: cfg.url, apiKey: cfg.apiKey });
}

function registry(): AgentConnector[] {
  return [
    new FsAgentConnector(cfg.roots ?? []),
    new GitAgentConnector(),
    new McpStdioAgentConnector(),
    new DbAgentConnector((name) => resolveDsn(name, cfg)),
  ];
}

const AGENT_VERSION = '0.1.0';

async function pass(id: string, only: string | undefined, json: boolean): Promise<SyncSummary[]> {
  const brain = client();
  const connectors = registry();
  // Check in first: presence and the folders this machine offers, so the
  // admin can pick one even before anything is pointed here.
  try {
    await brain.checkIn(id, await inventory(cfg.roots ?? [], AGENT_VERSION, databaseNames(cfg)));
  } catch (e) {
    process.stderr.write(`brain-agent: check-in failed: ${(e as Error).message}\n`);
  }
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
      redact: !flag('no-redact') && cfg.redact !== false,
      log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
    });
    out.push(summary);
    if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else {
      process.stdout.write(
        `${new Date().toISOString()} ${label}: ${summary.status} (${summary.mode}) seen=${summary.seen} new=${summary.new} changed=${summary.changed} gone=${summary.gone} fetched=${summary.fetched} ingested=${summary.ingested} dedup=${summary.deduplicated} failed=${summary.failed} closed=${summary.closed} in ${summary.durationMs}ms${summary.error ? ` — ${summary.error}` : ''}\n`,
      );
    }
  }
  return out;
}

function printStatus(s: ServiceStatus): void {
  process.stdout.write(`service: ${s.detail}${s.file ? ` (${s.file})` : ''}\n`);
}

async function install(): Promise<void> {
  const url = arg('url') ?? cfg.url;
  const apiKey = arg('key') ?? cfg.apiKey;
  if (!url) fail('install needs --url <brain url> (or BRAIN_URL)');
  if (!apiKey) fail('install needs --key <brain:write key> (or BRAIN_API_KEY)');
  try {
    new URL(url);
  } catch {
    fail(`--url "${url}" is not a URL`);
  }
  const every = arg('every') ? Number(arg('every')) : (cfg.everyMinutes ?? DEFAULT_EVERY_MINUTES);
  if (!(every > 0)) fail('--every must be a positive number of minutes');
  const roots = arg('roots') !== undefined ? arg('roots')!.split(':').map((r) => r.trim()).filter(Boolean) : (cfg.roots ?? []);
  const config: AgentConfig = {
    url: url.replace(/\/+$/, ''),
    apiKey,
    agentId: agentId(),
    roots,
    everyMinutes: every,
    redact: !flag('no-redact'),
    databases: cfg.databases ?? {},
  };
  const file = saveConfig(config);
  process.stdout.write(`config: ${file} (mode 600) — agent:${config.agentId} → ${config.url}, key ${maskKey(apiKey)}\n`);
  if (flag('no-service')) return;
  const status = await installService({
    node: process.execPath,
    script: realpathSync(process.argv[1] ?? ''),
    everyMinutes: every,
    logDir: defaultLogDir(),
    path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    configHome: process.env.BRAIN_AGENT_HOME,
  });
  printStatus(status);
  if (status.platform === 'systemd') {
    process.stdout.write('logs: journalctl --user -u brain-agent -f\n');
    process.stdout.write('headless box: loginctl enable-linger $USER so the unit runs without a login session\n');
  } else if (status.platform === 'launchd') {
    process.stdout.write(`logs: ${defaultLogDir()}/brain-agent.log\n`);
  }
}

async function status(): Promise<void> {
  const file = loadConfig() ? configPath() : null;
  process.stdout.write(
    file
      ? `config: ${file} — agent:${cfg.agentId} → ${cfg.url}, key ${maskKey(cfg.apiKey ?? '')}, every ${cfg.everyMinutes ?? DEFAULT_EVERY_MINUTES} min${cfg.roots?.length ? `, roots ${cfg.roots.join(':')}` : ''}\n`
      : 'config: none (environment only)\n',
  );
  printStatus(await serviceStatus());
  const log = tailLog(defaultLogDir(), 10);
  if (log.length > 0) process.stdout.write(`log:\n${log.map((l) => `  ${l}`).join('\n')}\n`);
  if (cfg.url && cfg.apiKey) {
    try {
      const targets = await client().listConnections(agentId());
      for (const t of targets) {
        const c = t.connection;
        process.stdout.write(
          `  ${c.status.padEnd(7)} ${c.label ?? `${c.packId}/${c.sourceId}`} — last sync ${c.lastSyncAt ?? 'never'}${c.lastSyncStatus ? ` (${c.lastSyncStatus})` : ''}${c.lastError ? ` — ${c.lastError}` : ''}\n`,
        );
      }
      if (targets.length === 0) process.stdout.write(`  (nothing pointed at agent:${agentId()})\n`);
    } catch (e) {
      process.stdout.write(`brain: ${(e as Error).message}\n`);
    }
  }
}

async function runDoctor(): Promise<void> {
  const file = loadConfig() ? configPath() : null;
  const checks = await doctor({
    config: { ...cfg, ...(cfg.agentId ? {} : { agentId: agentId() }) },
    configFile: file,
    configMode: configMode(),
    client: cfg.url && cfg.apiKey ? new BrainAgentClient({ baseUrl: cfg.url, apiKey: cfg.apiKey }) : null,
  });
  for (const c of checks) {
    const mark = c.verdict === 'ok' ? '✓' : c.verdict === 'warn' ? '!' : '✗';
    process.stdout.write(`${mark} ${c.name}: ${c.detail}\n`);
  }
  process.exit(worstVerdict(checks) === 'fail' ? 2 : 0);
}

/**
 * `db add <name> <dsn>` / `db list` / `db remove <name>` — the databases
 * this agent may read. The DSN is written to the config file (0600)
 * and never shown again; `list` prints names and dialects only.
 */
function dbCommand(): void {
  const sub = process.argv[3];
  const saved = loadConfig();
  if (sub === 'list') {
    const names = databaseNames(cfg);
    if (names.length === 0) process.stdout.write('(no databases — brain-agent db add <name> <dsn>, or BRAIN_AGENT_DB_<NAME>)\n');
    for (const name of names) {
      const dsn = resolveDsn(name, cfg) ?? '';
      const from = process.env[databaseEnvName(name)] ? databaseEnvName(name) : 'config';
      let dialect = '?';
      try {
        dialect = dialectOf(dsn);
      } catch {
        dialect = 'unknown';
      }
      process.stdout.write(`${name}  ${dialect}  (${from})\n`);
    }
    return;
  }
  if (!saved) fail('db add / remove need an installed agent (brain-agent install …); for a one-off pass set BRAIN_AGENT_DB_<NAME>');
  const name = (process.argv[4] ?? '').trim();
  if (!DATABASE_NAME.test(name)) fail('db <add|remove> <name> — letters, digits, "_" and "-", up to 64');
  if (sub === 'add') {
    const dsn = (process.argv[5] ?? '').trim();
    if (!dsn) fail(`db add ${name} <dsn> — postgres://…, mysql://… or sqlite:/path.db`);
    try {
      dialectOf(dsn);
    } catch (e) {
      fail((e as Error).message);
    }
    saveConfig({ ...saved, databases: { ...saved.databases, [name]: dsn } });
    process.stdout.write(`database ${name}: ${dialectOf(dsn)} — saved to ${configPath()} (mode 600); the brain sees the name only\n`);
    return;
  }
  if (sub === 'remove') {
    const { [name]: gone, ...rest } = saved.databases;
    saveConfig({ ...saved, databases: rest });
    process.stdout.write(`database ${name}: ${gone ? 'removed' : 'was not set'}\n`);
    return;
  }
  fail('usage: brain-agent db <add <name> <dsn> | list | remove <name>>');
}

const USAGE =
  'usage: brain-agent <install|uninstall|status|doctor|sync|list|db> [--agent <id>] [--connection <id>] [--full] [--every <min>] [--no-redact] [--json]\n' +
  '       brain-agent install --url <brain> --key <brain:write key> [--agent <id>] [--roots a:b] [--every <min>] [--no-service]\n' +
  '       brain-agent db add <name> <dsn> | db list | db remove <name>\n';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'install') return install();
  if (cmd === 'uninstall') {
    printStatus(await uninstallService());
    if (flag('purge')) process.stdout.write(`config: ${removeConfig() ? 'removed' : 'none'}\n`);
    return;
  }
  if (cmd === 'status') return status();
  if (cmd === 'doctor') return runDoctor();
  if (cmd === 'db') return dbCommand();
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
    process.stderr.write(USAGE);
    process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 1);
  }
  const every = arg('every') ? Number(arg('every')) : 0;
  for (;;) {
    let summaries: SyncSummary[] = [];
    try {
      summaries = await pass(id, arg('connection'), flag('json'));
    } catch (e) {
      // A service keeps going through a brain outage; a one-shot reports it.
      if (!(every > 0)) throw e;
      process.stderr.write(`${new Date().toISOString()} brain-agent: pass failed: ${(e as Error).message}\n`);
    }
    if (!(every > 0)) {
      process.exit(summaries.some((s) => s.status === 'failed') ? 2 : 0);
    }
    await new Promise((r) => setTimeout(r, every * 60_000));
  }
}

main().catch((e: unknown) => fail((e as Error).message));
