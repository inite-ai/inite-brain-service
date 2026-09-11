/**
 * The Claude Code plugin bundle is a distribution artefact with no
 * runtime that would notice it breaking: a wrong path in plugin.json,
 * a skill that drifted from skills/, or a userConfig key renamed out
 * from under the hook scripts all fail *on a user's machine*, days
 * later, silently. This spec is the only thing standing between a
 * rename and that outcome.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PLUGIN = join(ROOT, 'plugins/inite-brain');

const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

const marketplace = readJson(join(ROOT, '.claude-plugin/marketplace.json'));
const manifest = readJson(join(PLUGIN, '.claude-plugin/plugin.json'));

describe('claude-plugin marketplace', () => {
  it('declares the plugin at a path that exists', () => {
    const plugins = marketplace.plugins as { name: string; source: string; version?: string }[];
    expect(plugins).toHaveLength(1);
    const [entry] = plugins;
    expect(entry?.name).toBe(manifest.name);
    // Relative sources resolve against the marketplace root.
    const source = join(ROOT, entry?.source ?? '');
    expect(statSync(source).isDirectory()).toBe(true);
    expect(source).toBe(PLUGIN);
  });

  it('keeps the marketplace version and the manifest version identical', () => {
    // A marketplace `version` PINS the install. Two numbers means users
    // get whichever one is stale.
    const plugins = marketplace.plugins as { version?: string }[];
    expect(plugins[0]?.version).toBe(manifest.version);
  });

  it('names an owner, which the marketplace schema requires', () => {
    expect((marketplace.owner as { name?: string })?.name).toBeTruthy();
  });
});

describe('plugin manifest', () => {
  it('points every component path at a file that exists', () => {
    for (const key of ['mcpServers', 'hooks'] as const) {
      const rel = manifest[key] as string;
      expect(rel.startsWith('./')).toBe(true);
      expect(() => readFileSync(join(PLUGIN, rel), 'utf8')).not.toThrow();
    }
  });

  it('registers the MCP server against the configured base URL, not a hardcoded host', () => {
    const mcp = readJson(join(PLUGIN, '.mcp.json')) as {
      brain: { type: string; url: string; headers: Record<string, string> };
    };
    expect(mcp.brain.type).toBe('http');
    // Self-hosters change base_url and everything else must follow.
    expect(mcp.brain.url).toBe('${user_config.base_url}/mcp');
    expect(mcp.brain.headers.Authorization).toBe('Bearer ${user_config.api_key}');
  });

  it('marks the API key sensitive, so it lands in the keychain and not in a config file', () => {
    const cfg = manifest.userConfig as Record<string, { sensitive?: boolean; required?: boolean }>;
    expect(cfg.api_key?.sensitive).toBe(true);
    expect(cfg.api_key?.required).toBe(true);
  });
});

describe('hooks', () => {
  const hooks = readJson(join(PLUGIN, 'hooks/hooks.json')).hooks as Record<
    string,
    { hooks: { type: string; command: string }[] }[]
  >;

  it('covers recall on the way in and capture on both ways out', () => {
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionEnd', 'SessionStart']);
  });

  it('invokes only scripts that exist and are executable', () => {
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe('command');
          const rel = hook.command
            .replace(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?/, PLUGIN)
            .split(' ')[0] as string;
          // Throws if missing or not executable — which is exactly the
          // failure a user would otherwise hit at session start.
          expect(() => accessSync(rel, constants.X_OK)).not.toThrow();
        }
      }
    }
  });

  it('reads only option env vars the manifest actually declares', () => {
    // CLAUDE_PLUGIN_OPTION_<KEY> is derived from the userConfig key, so
    // renaming one side silently disables the hook. This is that guard.
    const declared = new Set(
      Object.keys(manifest.userConfig as Record<string, unknown>).map(
        (k) => `CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`,
      ),
    );
    const sources = ['hooks/brain-hook.sh', 'hooks/brain-hook.mjs']
      .map((f) => readFileSync(join(PLUGIN, f), 'utf8'))
      .join('\n');
    const used = sources.match(/CLAUDE_PLUGIN_OPTION_[A-Z_]+/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) expect(declared).toContain(name);
  });

  it('parses as valid JavaScript', () => {
    // A syntax error here fails silently at runtime (the dispatcher
    // swallows it), so check it at build time instead.
    expect(() =>
      execFileSync(process.execPath, ['--check', join(PLUGIN, 'hooks/brain-hook.mjs')]),
    ).not.toThrow();
  });
});

const dirsIn = (p: string): string[] =>
  readdirSync(p)
    .filter((n) => statSync(join(p, n)).isDirectory())
    .sort();

describe('bundled skills', () => {
  it('matches skills/ exactly — pnpm plugin:sync regenerates it', () => {
    const source = dirsIn(join(ROOT, 'skills'));
    expect(dirsIn(join(PLUGIN, 'skills'))).toEqual(source);
    for (const name of source) {
      const a = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      const b = readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
      expect(b).toBe(a);
    }
  });

  it('carries the bundle version so an installed plugin can name itself', () => {
    expect(readFileSync(join(PLUGIN, 'skills/VERSION'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'skills/VERSION'), 'utf8'),
    );
  });
});

/**
 * The Gemini CLI extension. Same class of artefact as the plugin above —
 * `gemini extensions install <repo url>` reads this file and nothing in
 * our build would notice it rotting.
 */
describe('gemini extension manifest', () => {
  const gemini = readJson(join(ROOT, 'gemini-extension.json'));

  it('has the three fields the loader requires', () => {
    for (const key of ['name', 'version', 'description'] as const) {
      expect(typeof gemini[key]).toBe('string');
      expect((gemini[key] as string).length).toBeGreaterThan(0);
    }
  });

  it('points contextFileName at a file that exists', () => {
    // A missing context file is a silent no-op: the extension installs,
    // the guidance never loads, and the agent behaves as if the skills
    // were never written.
    expect(() => readFileSync(join(ROOT, gemini.contextFileName as string), 'utf8')).not.toThrow();
  });

  it('carries the key in a header the CLI expands from the environment', () => {
    // Gemini expands ${VAR} inside headers. A literal key here would be
    // a secret committed to a public repository.
    const servers = gemini.mcpServers as Record<
      string,
      { httpUrl: string; headers: Record<string, string> }
    >;
    expect(servers.brain?.httpUrl).toBe('https://brain.inite.ai/mcp');
    expect(servers.brain?.headers.Authorization).toBe('Bearer ${BRAIN_API_KEY}');
    // The field is httpUrl, not url — Gemini ignores `url` for HTTP
    // transports, and the failure is a server that never connects.
    expect(servers.brain).not.toHaveProperty('url');
  });

  it('ships the skills the extension root already carries', () => {
    // Unlike the Claude plugin, the extension root IS the repository
    // root, so skills/ needs no copy — but it does need to be there.
    expect(dirsIn(join(ROOT, 'skills')).length).toBeGreaterThan(0);
  });
});
