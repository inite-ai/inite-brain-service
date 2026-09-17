import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The agent as a background service — a launchd user agent on macOS, a
 * systemd user unit on Linux. Both start `node <this script> sync
 * --every <n>` at login and restart it when it dies; neither file
 * carries a secret: the agent reads its key from the config file
 * (mode 0600) at start. Everything here is argv arrays into execFile —
 * no shell, nothing quoted by hand.
 */
export const SERVICE_LABEL = 'ai.inite.brain-agent';

export interface ServiceSpec {
  /** The node binary that will run the agent (process.execPath). */
  node: string;
  /** The agent's entry script (dist/index.js), absolute. */
  script: string;
  everyMinutes: number;
  /** Where stdout / stderr go on macOS (journald keeps them on Linux). */
  logDir: string;
  /** PATH the service sees — launchd gives almost nothing by default; git must be on it. */
  path: string;
  /** A non-default config dir (BRAIN_AGENT_HOME) the service must read from; no secret, just a path. */
  configHome?: string | undefined;
}

export type ServicePlatform = 'launchd' | 'systemd' | 'unsupported';

export function servicePlatform(os: string = platform()): ServicePlatform {
  if (os === 'darwin') return 'launchd';
  if (os === 'linux') return 'systemd';
  return 'unsupported';
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ~/Library/LaunchAgents/<label>.plist — a per-user agent, loaded at login. */
export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.node, spec.script, 'sync', '--every', String(spec.everyMinutes)];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key><string>${xmlEscape(spec.path)}</string>`,
    ...(spec.configHome ? [`    <key>BRAIN_AGENT_HOME</key><string>${xmlEscape(spec.configHome)}</string>`] : []),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>StandardOutPath</key><string>${xmlEscape(join(spec.logDir, 'brain-agent.log'))}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(join(spec.logDir, 'brain-agent.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** ~/.config/systemd/user/brain-agent.service — a user unit, enabled at login (linger for headless boxes). */
export function systemdUnit(spec: ServiceSpec): string {
  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  return [
    '[Unit]',
    'Description=INITE Brain local agent — syncs the folders, repositories and MCP servers on this machine',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${q(spec.node)} ${q(spec.script)} sync --every ${spec.everyMinutes}`,
    `Environment=PATH=${spec.path}`,
    ...(spec.configHome ? [`Environment=BRAIN_AGENT_HOME=${spec.configHome}`] : []),
    'Restart=on-failure',
    'RestartSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.config'), 'systemd', 'user', 'brain-agent.service');
}

export function defaultLogDir(home: string = homedir()): string {
  return platform() === 'darwin' ? join(home, 'Library', 'Logs', 'brain-agent') : join(home, '.local', 'state', 'brain-agent');
}

/** launchd's domain for the calling user (`gui/<uid>`). */
function launchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

export interface ServiceStatus {
  platform: ServicePlatform;
  installed: boolean;
  running: boolean;
  file: string | null;
  detail: string;
}

/** Write the unit / plist and start it. Idempotent: an existing service is replaced. */
export async function installService(spec: ServiceSpec): Promise<ServiceStatus> {
  const target = servicePlatform();
  if (target === 'launchd') {
    const file = launchdPlistPath();
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(spec.logDir, { recursive: true });
    // Replacing a loaded agent: boot it out first, ignore "not loaded".
    await run('launchctl', ['bootout', `${launchdDomain()}/${SERVICE_LABEL}`]).catch(() => undefined);
    writeFileSync(file, launchdPlist(spec), { mode: 0o644 });
    await run('launchctl', ['bootstrap', launchdDomain(), file]);
    return serviceStatus();
  }
  if (target === 'systemd') {
    const file = systemdUnitPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(spec), { mode: 0o644 });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'brain-agent.service']);
    return serviceStatus();
  }
  throw new Error(
    `no service manager for ${platform()} yet — run "brain-agent sync --every <minutes>" under your scheduler (Task Scheduler on Windows)`,
  );
}

export async function uninstallService(): Promise<ServiceStatus> {
  const target = servicePlatform();
  if (target === 'launchd') {
    await run('launchctl', ['bootout', `${launchdDomain()}/${SERVICE_LABEL}`]).catch(() => undefined);
    rmSync(launchdPlistPath(), { force: true });
    // bootout returns before the job is gone; a status read right after
    // would still see the old pid.
    for (let i = 0; i < 20 && (await serviceStatus()).running; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } else if (target === 'systemd') {
    await run('systemctl', ['--user', 'disable', '--now', 'brain-agent.service']).catch(() => undefined);
    rmSync(systemdUnitPath(), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  }
  return serviceStatus();
}

export async function serviceStatus(): Promise<ServiceStatus> {
  const target = servicePlatform();
  if (target === 'launchd') {
    const file = launchdPlistPath();
    const installed = exists(file);
    try {
      const { stdout } = await run('launchctl', ['print', `${launchdDomain()}/${SERVICE_LABEL}`]);
      const pid = /\bpid = (\d+)/.exec(stdout)?.[1];
      const state = /\bstate = (\w+)/.exec(stdout)?.[1] ?? 'loaded';
      return {
        platform: target,
        installed,
        running: pid !== undefined,
        file,
        detail: pid ? `running (pid ${pid})` : state,
      };
    } catch {
      return { platform: target, installed, running: false, file, detail: installed ? 'not loaded' : 'not installed' };
    }
  }
  if (target === 'systemd') {
    const file = systemdUnitPath();
    const installed = exists(file);
    try {
      const { stdout } = await run('systemctl', ['--user', 'is-active', 'brain-agent.service']);
      const state = stdout.trim();
      return { platform: target, installed, running: state === 'active', file, detail: state };
    } catch (e) {
      const state = ((e as { stdout?: string }).stdout ?? '').trim() || 'inactive';
      return { platform: target, installed, running: false, file, detail: installed ? state : 'not installed' };
    }
  }
  return { platform: target, installed: false, running: false, file: null, detail: `no service manager for ${platform()}` };
}

function exists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The last lines of the macOS log file (journald owns them on Linux). */
export function tailLog(logDir: string, lines = 20): string[] {
  try {
    const all = readFileSync(join(logDir, 'brain-agent.log'), 'utf8').split('\n').filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}
