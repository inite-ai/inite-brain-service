/**
 * The ecosystem-module registry — EXPLICIT by design.
 *
 * No filesystem auto-discovery: what an operator's indexer runs is a
 * list in source, reviewable in a diff. Adding Python is one new file
 * under `modules/` plus one entry here; nothing in `core/` changes.
 *
 * Ships today:
 *   - `javascript`         package.json + pnpm-lock.yaml → depends_on_version
 *   - `config_catalog`     config-catalog*.data.ts       → default_value
 *   - `default_constants`  DEFAULT_* literals            → default_value
 *
 * A repository with none of these still gets everything `core/` derives
 * (ownership, decisions, rationale, invariants, gotchas) — modules add
 * ecosystem depth, they are never a precondition for output.
 */
import { JAVASCRIPT_MODULE } from './javascript.module';
import { CONFIG_CATALOG_MODULE, DEFAULT_CONSTANTS_MODULE } from './config.module';
import type { EcosystemModule } from './module.types';

export const BUILTIN_MODULES: readonly EcosystemModule[] = [
  JAVASCRIPT_MODULE,
  CONFIG_CATALOG_MODULE,
  DEFAULT_CONSTANTS_MODULE,
];

/** Resolve `--modules a,b` against the registry; unknown ids throw. */
export function selectModules(ids: string[] | undefined): readonly EcosystemModule[] {
  if (!ids || ids.length === 0) return BUILTIN_MODULES;
  return ids.map((id) => {
    const found = BUILTIN_MODULES.find((m) => m.id === id);
    if (!found) {
      throw new Error(
        `unknown ecosystem module "${id}" (available: ${BUILTIN_MODULES.map((m) => m.id).join(', ')})`,
      );
    }
    return found;
  });
}
