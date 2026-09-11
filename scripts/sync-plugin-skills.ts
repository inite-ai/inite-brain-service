/**
 * Mirror skills/ into the Claude Code plugin bundle.
 *
 * A plugin's components must live under its own root — `skills/` is
 * resolved relative to `plugins/inite-brain/`, and a path that escapes
 * the plugin root is not a supported manifest value. So the bundle
 * carries a copy, and `skills/` stays the single source of truth: this
 * script writes the copy, and test/plugin-bundle.unit-spec.ts fails the
 * build if the two ever drift.
 *
 * Run:
 *   pnpm plugin:sync         (also runs inside pnpm skills:pack)
 *   pnpm plugin:sync --check (report drift, write nothing, exit 1)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'skills');
const DEST = join(ROOT, 'plugins/inite-brain/skills');

/** Skill directories, i.e. everything except the bundle's own metadata. */
export function skillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function main(): void {
  const check = process.argv.includes('--check');
  const names = skillDirs(SRC);
  if (names.length === 0) {
    console.error(`! no skills found in ${SRC}`);
    process.exit(1);
  }

  if (check) {
    const have = skillDirs(DEST);
    const missing = names.filter((n) => !have.includes(n));
    const extra = have.filter((n) => !names.includes(n));
    if (missing.length || extra.length) {
      console.error(`! plugin skills drifted (missing: ${missing}, extra: ${extra})`);
      process.exit(1);
    }
    console.log(`plugin skills in sync (${names.length})`);
    return;
  }

  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const name of names) {
    cpSync(join(SRC, name), join(DEST, name), { recursive: true });
  }
  // VERSION travels with the copy so an installed plugin can say which
  // bundle it carries without a network call.
  cpSync(join(SRC, 'VERSION'), join(DEST, 'VERSION'));
  console.log(`synced ${names.length} skills → ${DEST}`);
}

if (require.main === module) main();
