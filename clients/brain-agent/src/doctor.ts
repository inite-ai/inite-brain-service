import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { databaseNames, resolveDsn, type AgentConfig } from './config.js';
import { dialectOf, openSession } from './connectors/db-session.js';
import { BrainApiError, type BrainAgentClient } from './protocol.js';

const run = promisify(execFile);

/**
 * `brain-agent doctor` — the questions an operator asks when "nothing
 * happens": is there a config, can the brain be reached with this key,
 * does it point anything at this agent, are the roots readable, is git
 * there. Each check is one line with a verdict; the exit code is the
 * worst of them.
 */
export type Verdict = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
}

export interface DoctorInput {
  config: Partial<AgentConfig>;
  configFile: string | null;
  configMode: number | null;
  client: BrainAgentClient | null;
  /** Injected for tests; default runs `git --version`. */
  gitVersion?: () => Promise<string>;
  nodeVersion?: string;
  /** Injected for tests; default opens the database read-only and runs `SELECT 1`. */
  openDb?: (dsn: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export async function doctor(input: DoctorInput): Promise<Check[]> {
  const checks: Check[] = [];
  const { config } = input;

  checks.push(
    input.configFile
      ? input.configMode !== null && (input.configMode & 0o077) !== 0
        ? { name: 'config', verdict: 'warn', detail: `${input.configFile} is readable by others (mode ${input.configMode.toString(8)}); chmod 600` }
        : { name: 'config', verdict: 'ok', detail: input.configFile }
      : config.url && config.apiKey
        ? { name: 'config', verdict: 'ok', detail: 'from environment (no config file)' }
        : { name: 'config', verdict: 'fail', detail: 'no config file and BRAIN_URL / BRAIN_API_KEY not set — run brain-agent install' },
  );

  const node = input.nodeVersion ?? process.versions.node;
  const major = Number(node.split('.')[0]);
  checks.push(
    major >= 20
      ? { name: 'node', verdict: 'ok', detail: `v${node}` }
      : { name: 'node', verdict: 'fail', detail: `v${node} — the agent needs Node 20 or newer` },
  );

  try {
    const v = (await (input.gitVersion ?? defaultGitVersion)()).trim();
    checks.push({ name: 'git', verdict: 'ok', detail: v });
  } catch {
    checks.push({ name: 'git', verdict: 'warn', detail: 'git not found on PATH — repository connections will fail' });
  }

  // Every database the agent knows: the DSN parses, the driver is there, a read-only session opens.
  for (const name of databaseNames(config, input.env)) {
    const dsn = resolveDsn(name, config, input.env) ?? '';
    let dialect: string;
    try {
      dialect = dialectOf(dsn);
    } catch (e) {
      checks.push({ name: `db ${name}`, verdict: 'fail', detail: (e as Error).message });
      continue;
    }
    try {
      await (input.openDb ?? probeDb)(dsn);
      checks.push({ name: `db ${name}`, verdict: 'ok', detail: `${dialect}, read-only session opens` });
    } catch (e) {
      checks.push({ name: `db ${name}`, verdict: 'fail', detail: `${dialect}: ${(e as Error).message}` });
    }
  }

  for (const root of config.roots ?? []) {
    try {
      const st = statSync(root);
      if (!st.isDirectory()) checks.push({ name: `root ${root}`, verdict: 'fail', detail: 'not a directory' });
      else {
        accessSync(root, constants.R_OK);
        checks.push({ name: `root ${root}`, verdict: 'ok', detail: 'readable' });
      }
    } catch {
      checks.push({ name: `root ${root}`, verdict: 'fail', detail: 'missing or unreadable' });
    }
  }

  if (!input.client || !config.agentId) {
    checks.push({ name: 'brain', verdict: 'fail', detail: 'cannot reach the brain without url, key and agent id' });
    return checks;
  }
  try {
    const targets = await input.client.listConnections(config.agentId);
    const active = targets.filter((t) => t.connection.status === 'active').length;
    checks.push({
      name: 'brain',
      verdict: 'ok',
      detail: `${config.url} answers; key accepted (${config.apiKey ? 'brain:write' : '?'})`,
    });
    checks.push(
      targets.length === 0
        ? {
            name: `agent:${config.agentId}`,
            verdict: 'warn',
            detail: 'nothing is pointed at this agent yet — connect a source in Admin → Connections and choose "on a local agent"',
          }
        : {
            name: `agent:${config.agentId}`,
            verdict: 'ok',
            detail: `${targets.length} connection(s), ${active} active: ${targets
              .map((t) => t.connection.label ?? `${t.connection.packId}/${t.connection.sourceId}`)
              .join(', ')}`,
          },
    );
  } catch (e) {
    const err = e as BrainApiError | Error;
    const status = err instanceof BrainApiError ? err.status : undefined;
    checks.push({
      name: 'brain',
      verdict: 'fail',
      detail:
        status === 401
          ? `${config.url}: the key was refused (401) — issue a new one in Admin → Connections → Local agents`
          : status === 403
            ? `${config.url}: the key lacks brain:write (403)`
            : status === 404
              ? `${config.url}: the source plane is off there (404) — SOURCE_PLANE_ENABLED=1 on the brain`
              : `${config.url}: ${err.message}`,
    });
  }
  return checks;
}

async function defaultGitVersion(): Promise<string> {
  const { stdout } = await run('git', ['--version']);
  return stdout;
}

export function worstVerdict(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === 'fail')) return 'fail';
  if (checks.some((c) => c.verdict === 'warn')) return 'warn';
  return 'ok';
}

async function probeDb(dsn: string): Promise<void> {
  const session = await openSession(dsn);
  try {
    await session.query('SELECT 1', []);
  } finally {
    await session.close();
  }
}
