import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * A reusable workflow can never hold more GITHUB_TOKEN scope than the job
 * that calls it grants. When a callee asks for more, GitHub refuses the
 * whole calling run before any job starts (`startup_failure`) and says
 * nothing in the logs. #871 gave release-image.yml's signing job
 * `id-token: write` + `attestations: write` while release-please.yml's
 * `image` caller still inherited `contents: read`, and from that merge on
 * release-please did not run at all: no release PR update, no release, no
 * deploy, for a day of merges.
 *
 * So for every `uses: ./.github/workflows/…` call, each scope any callee
 * job (or the callee's top level) requests must be granted by the caller
 * job, `write` covering `read`.
 */
const WORKFLOWS = join(__dirname, '..', '.github', 'workflows');

type Permissions = Record<string, string> | string | undefined;
interface Job {
  uses?: string;
  permissions?: Permissions;
}
interface Workflow {
  permissions?: Permissions;
  jobs?: Record<string, Job>;
}

const read = (file: string): Workflow =>
  parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

/** A permissions block as scope → level; the shorthands expand to every scope. */
function levels(p: Permissions, scopes: string[]): Map<string, number> {
  if (typeof p === 'string') {
    const all = p === 'write-all' ? 2 : p === 'read-all' ? 1 : 0;
    return new Map(scopes.map((s) => [s, all]));
  }
  return new Map(Object.entries(p ?? {}).map(([s, l]) => [s, LEVEL[l] ?? 0]));
}

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
const calls = files.flatMap((file) =>
  Object.entries(read(file).jobs ?? {})
    .filter(([, job]) => job.uses?.startsWith('./.github/workflows/'))
    .map(([name, job]) => ({ file, name, job })),
);

describe('reusable workflow permissions', () => {
  it('finds the local workflow calls it checks', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls.map((c) => [`${c.file} › ${c.name}`, c] as const))(
    '%s grants every scope its callee requests',
    (_label, { file, job }) => {
      const callee = read(job.uses!.replace('./.github/workflows/', ''));
      const requested = [
        callee.permissions,
        ...Object.values(callee.jobs ?? {}).map((j) => j.permissions),
      ];
      const scopes = [
        ...new Set(requested.flatMap((p) => (p && typeof p === 'object' ? Object.keys(p) : []))),
      ];
      // A caller job without its own block runs with the workflow's.
      const granted = levels(job.permissions ?? read(file).permissions, scopes);
      const missing = requested.flatMap((p) =>
        [...levels(p, scopes)].filter(([s, l]) => (granted.get(s) ?? 0) < l).map(([s]) => s),
      );
      expect([...new Set(missing)]).toEqual([]);
    },
  );
});
