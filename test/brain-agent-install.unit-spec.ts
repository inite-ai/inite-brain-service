/**
 * The installable agent: the config file (one file, owner-only, env
 * wins), the service definitions (launchd plist / systemd unit — no
 * secret in either, argv as arrays), and the doctor's verdicts.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  configMode,
  loadConfig,
  maskKey,
  removeConfig,
  resolveConfig,
  saveConfig,
} from '../clients/brain-agent/src/config';
import { doctor, worstVerdict } from '../clients/brain-agent/src/doctor';
import { BrainAgentClient, BrainApiError } from '../clients/brain-agent/src/protocol';
import {
  launchdPlist,
  servicePlatform,
  systemdUnit,
  systemdUnitPath,
} from '../clients/brain-agent/src/service';

describe('brain-agent config', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'brain-agent-cfg-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('BRAIN_AGENT_HOME, else XDG, else ~/.config/brain-agent', () => {
    expect(configDir({ BRAIN_AGENT_HOME: '/x' })).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/brain-agent');
    expect(configDir({})).toMatch(/\/\.config\/brain-agent$/);
  });

  it('saves owner-only, loads back, and the environment overrides field by field', () => {
    const env = { BRAIN_AGENT_HOME: home };
    expect(loadConfig(env)).toBeNull();
    const file = saveConfig(
      {
        url: 'https://brain.test',
        apiKey: 'key_abcdefghijklmnop',
        agentId: 'laptop',
        roots: ['/srv'],
        everyMinutes: 5,
        redact: true,
        databases: {},
      },
      env,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(configDir(env)).mode & 0o777).toBe(0o700);
    expect(configMode(env)).toBe(0o600);
    expect(loadConfig(env)).toMatchObject({
      url: 'https://brain.test',
      agentId: 'laptop',
      roots: ['/srv'],
      everyMinutes: 5,
    });
    expect(
      resolveConfig({ ...env, BRAIN_AGENT_ID: 'ci-1', BRAIN_AGENT_ROOTS: '/a:/b' }),
    ).toMatchObject({
      url: 'https://brain.test',
      apiKey: 'key_abcdefghijklmnop',
      agentId: 'ci-1',
      roots: ['/a', '/b'],
    });
    expect(maskKey('key_abcdefghijklmnop')).toBe('key_abcd…mnop');
    expect(maskKey('short')).toBe('••••');
    expect(removeConfig(env)).toBe(true);
    expect(loadConfig(env)).toBeNull();
  });

  it('a config file missing its identity is an error, not a silent default', () => {
    const env = { BRAIN_AGENT_HOME: home };
    saveConfig(
      {
        url: 'https://brain.test',
        apiKey: 'k',
        agentId: 'a',
        roots: [],
        everyMinutes: 5,
        redact: true,
        databases: {},
      },
      env,
    );
    const bad = join(home, 'config.json');
    writeFileSync(bad, '{"url":"https://brain.test"}');
    expect(() => loadConfig(env)).toThrow(/missing url \/ apiKey \/ agentId/);
  });
});

describe('brain-agent service definitions', () => {
  const spec = {
    node: '/usr/local/bin/node',
    script: '/opt/brain-agent/dist/index.js',
    everyMinutes: 15,
    logDir: '/Users/me/Library/Logs/brain-agent',
    path: '/usr/local/bin:/usr/bin',
  };

  it('launchd: argv as strings, PATH only, logs, keep-alive — and never a key', () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain('<key>Label</key><string>ai.inite.brain-agent</string>');
    expect(plist).toContain(
      '<string>/usr/local/bin/node</string>\n    <string>/opt/brain-agent/dist/index.js</string>\n    <string>sync</string>\n    <string>--every</string>\n    <string>15</string>',
    );
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('brain-agent.log');
    expect(plist).not.toMatch(/BRAIN_API_KEY|key_/);
    expect(launchdPlist({ ...spec, configHome: '/tmp/a&b' })).toContain(
      '<key>BRAIN_AGENT_HOME</key><string>/tmp/a&amp;b</string>',
    );
  });

  it('systemd: a user unit with restart, quoted ExecStart, and no key', () => {
    const unit = systemdUnit({
      ...spec,
      script: '/opt/my agent/dist/index.js',
      configHome: '/home/me/.cfg',
    });
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/my agent/dist/index.js" sync --every 15',
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Environment=BRAIN_AGENT_HOME=/home/me/.cfg');
    expect(unit).not.toMatch(/BRAIN_API_KEY/);
    expect(systemdUnitPath('/home/me', {})).toBe(
      '/home/me/.config/systemd/user/brain-agent.service',
    );
    expect(systemdUnitPath('/home/me', { XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/xdg/systemd/user/brain-agent.service',
    );
  });

  it('knows which service manager a platform has', () => {
    expect(servicePlatform('darwin')).toBe('launchd');
    expect(servicePlatform('linux')).toBe('systemd');
    expect(servicePlatform('win32')).toBe('unsupported');
  });
});

describe('brain-agent doctor', () => {
  const fakeClient = (handler: () => Promise<Response>) =>
    new BrainAgentClient({
      baseUrl: 'https://brain.test',
      apiKey: 'key_abcdefghijklmnop',
      fetch: handler,
    });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const git = async () => 'git version 2.50.1';

  it('no config, no env: the first check fails and says what to run', async () => {
    const checks = await doctor({
      config: {},
      configFile: null,
      configMode: null,
      client: null,
      gitVersion: git,
    });
    expect(checks[0]).toMatchObject({ name: 'config', verdict: 'fail' });
    expect(checks[0]!.detail).toContain('brain-agent install');
    expect(worstVerdict(checks)).toBe('fail');
  });

  it('a reachable brain with nothing pointed at the agent is a warning that names the next step', async () => {
    const checks = await doctor({
      config: {
        url: 'https://brain.test',
        apiKey: 'key_abcdefghijklmnop',
        agentId: 'laptop',
        roots: [],
      },
      configFile: '/home/me/.config/brain-agent/config.json',
      configMode: 0o600,
      client: fakeClient(async () => json({ connections: [] })),
      gitVersion: git,
    });
    expect(checks.find((c) => c.name === 'brain')).toMatchObject({ verdict: 'ok' });
    expect(checks.find((c) => c.name === 'agent:laptop')).toMatchObject({ verdict: 'warn' });
    expect(worstVerdict(checks)).toBe('warn');
  });

  it('a refused key, a group-readable config, a missing root and a missing git are each named', async () => {
    const checks = await doctor({
      config: {
        url: 'https://brain.test',
        apiKey: 'key_abcdefghijklmnop',
        agentId: 'laptop',
        roots: ['/definitely/not/here'],
      },
      configFile: '/home/me/.config/brain-agent/config.json',
      configMode: 0o644,
      client: fakeClient(async () => json({ message: 'invalid credentials' }, 401)),
      gitVersion: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(checks.find((c) => c.name === 'config')).toMatchObject({ verdict: 'warn' });
    expect(checks.find((c) => c.name === 'git')).toMatchObject({ verdict: 'warn' });
    expect(checks.find((c) => c.name.startsWith('root '))).toMatchObject({ verdict: 'fail' });
    const brain = checks.find((c) => c.name === 'brain')!;
    expect(brain.verdict).toBe('fail');
    expect(brain.detail).toContain('401');
    expect(worstVerdict(checks)).toBe('fail');
  });

  it('the source plane being off on the brain reads as 404 with the flag to set', async () => {
    const checks = await doctor({
      config: {
        url: 'https://brain.test',
        apiKey: 'key_abcdefghijklmnop',
        agentId: 'laptop',
        roots: [],
      },
      configFile: null,
      configMode: null,
      client: fakeClient(async () => json({ message: 'Not Found' }, 404)),
      gitVersion: git,
    });
    expect(checks.find((c) => c.name === 'brain')!.detail).toContain('SOURCE_PLANE_ENABLED');
    expect(new BrainApiError(404, 'x').status).toBe(404);
  });
});
