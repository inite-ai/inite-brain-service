import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * A workflow file GitHub cannot parse does not fail loudly: it produces a
 * run with no jobs, conclusion "failure" and no log to read, on every push,
 * for as long as nobody looks. `publish-clients.yml` shipped that way — an
 * unquoted `description: … (default: the default branch)` put a second
 * `: ` in a plain scalar — and the client packages the admin UI tells an
 * operator to install had no workflow behind them for as long as it took to
 * notice.
 *
 * So every workflow in the repository is parsed here. This is not a
 * schema check; it is the one failure that hides.
 */
const DIR = join(__dirname, '..', '.github', 'workflows');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('.github/workflows', () => {
  it('has workflows to check', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it.each(FILES)('%s is valid YAML with a name, a trigger and something to run', (file) => {
    const raw = readFileSync(join(DIR, file), 'utf8');
    let doc: unknown;
    expect(() => {
      doc = parse(raw);
    }).not.toThrow();
    const wf = doc as Record<string, unknown>;
    expect(typeof wf.name).toBe('string');
    // `on:` is YAML 1.1's boolean true — the parser hands it back as such.
    expect(wf.on ?? wf[true as unknown as string]).toBeDefined();
    expect(wf.jobs).toBeDefined();
    expect(Object.keys(wf.jobs as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
