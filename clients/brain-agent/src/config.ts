import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The agent's saved configuration — what `brain-agent install` writes
 * and what a service-started agent reads, so the key lives in exactly
 * one file (mode 0600) and never inside a launchd plist or a systemd
 * unit. Environment variables, when set, win over the file: a CI job
 * passes secrets that way and never writes a file.
 */
export interface AgentConfig {
  url: string;
  apiKey: string;
  agentId: string;
  /** ':'-separated on the wire, a list here. */
  roots: string[];
  /** Minutes between passes when run as a service. */
  everyMinutes: number;
  redact: boolean;
}

export const CONFIG_FILE = 'config.json';
export const DEFAULT_EVERY_MINUTES = 5;

/** `$BRAIN_AGENT_HOME`, else `$XDG_CONFIG_HOME/brain-agent`, else `~/.config/brain-agent`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRAIN_AGENT_HOME) return env.BRAIN_AGENT_HOME;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'brain-agent');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), CONFIG_FILE);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath(env), 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<AgentConfig>;
  if (typeof parsed.url !== 'string' || typeof parsed.apiKey !== 'string' || typeof parsed.agentId !== 'string') {
    throw new Error(`${configPath(env)} is missing url / apiKey / agentId`);
  }
  return {
    url: parsed.url,
    apiKey: parsed.apiKey,
    agentId: parsed.agentId,
    roots: Array.isArray(parsed.roots) ? parsed.roots.map(String) : [],
    everyMinutes:
      typeof parsed.everyMinutes === 'number' && parsed.everyMinutes > 0
        ? parsed.everyMinutes
        : DEFAULT_EVERY_MINUTES,
    redact: parsed.redact !== false,
  };
}

/** Atomic, owner-only: written next to the target, then renamed over it. */
export function saveConfig(config: AgentConfig, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = configPath(env);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}

export function removeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    rmSync(configPath(env));
    return true;
  } catch {
    return false;
  }
}

/** The file's permission bits, or null when it does not exist — the doctor checks 0600. */
export function configMode(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    return statSync(configPath(env)).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Environment first (a CI job, an operator's shell), the file second —
 * every field independently, so `BRAIN_AGENT_ID=ci-x brain-agent sync`
 * on an installed machine still uses the saved url and key.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): Partial<AgentConfig> {
  const file = loadConfig(env);
  const roots = env.BRAIN_AGENT_ROOTS;
  return {
    ...(file ?? {}),
    ...(env.BRAIN_URL ? { url: env.BRAIN_URL } : {}),
    ...(env.BRAIN_API_KEY ? { apiKey: env.BRAIN_API_KEY } : {}),
    ...(env.BRAIN_AGENT_ID ? { agentId: env.BRAIN_AGENT_ID } : {}),
    ...(roots !== undefined ? { roots: roots.split(':').map((r) => r.trim()).filter(Boolean) } : {}),
  };
}

/** `key_abcd…wxyz` — enough to tell keys apart, never enough to use one. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
