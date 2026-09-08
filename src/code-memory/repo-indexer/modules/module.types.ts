/**
 * The ecosystem-module seam.
 *
 * The CORE of this indexer is language-agnostic on purpose: git history,
 * CODEOWNERS, commit-message decisions, ADR docs and warning comments
 * mean the same thing in every repository, and a repo whose ecosystem
 * has no module still gets all of that. Everything past that point is
 * ecosystem-specific and cannot be combed under one rule — a dependency
 * pin lives in package.json here, pyproject.toml there, go.mod
 * elsewhere, and each has its own notion of what "the version" is.
 *
 * So ecosystem knowledge lives ONLY in modules. A module declares which
 * files it claims and returns the same {@link RepoFact} shape the core
 * emits; the core never learns a filename, a manifest format, or a
 * language.
 *
 * ADDING AN ECOSYSTEM is one new file plus one line in `registry.ts`:
 *
 *   // modules/python.module.ts
 *   export const PYTHON_MODULE: EcosystemModule = {
 *     id: 'python',
 *     version: '1.0.0',
 *     description: 'pyproject.toml / requirements.txt dependency pins',
 *     priority: 50,
 *     claims: (path) => /(^|\/)(pyproject\.toml|requirements\.txt)$/.test(path),
 *     extract: ({ paths, source }) => paths.flatMap((p) => …),
 *   };
 *
 * …then `BUILTIN_MODULES = [JAVASCRIPT_MODULE, CONFIG_CATALOG_MODULE,
 * PYTHON_MODULE]`. No core file changes.
 */
import type { RepoSource } from '../repo-source';
import type { IndexerCaps, RepoFact } from '../types';

export interface ModuleExtractInput {
  /**
   * The paths this module WON — already filtered by `claims()` and by
   * conflict resolution, so a module never has to re-check ownership of
   * a file another module also claimed.
   */
  paths: string[];
  source: RepoSource;
  caps: IndexerCaps;
}

export interface EcosystemModule {
  /** Stable id; appears in every fact's producer as `module:<id>@<version>`. */
  id: string;
  /**
   * Module version, INDEPENDENT of the pack version. Bump it whenever
   * the extraction rules change: the new value rides into the derivation
   * of every fact the module produces, so an operator can see exactly
   * which rule revision minted a claim.
   */
  version: string;
  description: string;
  /**
   * Conflict tie-break. When two modules claim one path the HIGHER
   * priority wins outright; equal priorities are broken by ascending
   * `id`. Deterministic by construction — never registration order.
   */
  priority: number;
  /** Does this module read this repo-relative path? Pure, no I/O. */
  claims(path: string): boolean;
  /** Derive facts from the won paths. Must emit only artefact-traceable claims. */
  extract(input: ModuleExtractInput): RepoFact[];
}

/** `module:javascript@1.0.0` — the producer tag for a module's facts. */
export function moduleProducer(mod: EcosystemModule): `module:${string}` {
  return `module:${mod.id}@${mod.version}`;
}

export interface PathAssignment {
  moduleId: string;
  paths: string[];
}

/**
 * Deterministically assign every path to at most one module.
 *
 * Documented resolution: highest `priority` wins; ties break on
 * ascending `id`. Registration order is deliberately NOT consulted so a
 * registry reshuffle can never change what gets indexed.
 */
export function assignPaths(
  modules: readonly EcosystemModule[],
  paths: readonly string[],
): Map<string, string[]> {
  const ranked = [...modules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const assigned = new Map<string, string[]>();
  for (const path of paths) {
    const winner = ranked.find((m) => m.claims(path));
    if (!winner) continue;
    const bucket = assigned.get(winner.id) ?? [];
    bucket.push(path);
    assigned.set(winner.id, bucket);
  }
  return assigned;
}
