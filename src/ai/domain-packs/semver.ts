/**
 * Minimal semver ordering for pack versions. Pack versions are validated as
 * strict `MAJOR.MINOR.PATCH` (validate.ts SEMVER regex) — no pre-release /
 * build metadata — so a numeric tuple compare is exact and dependency-free.
 */

function parts(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver strings. -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** The highest version in the list, or null if empty. */
export function pickLatestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}
