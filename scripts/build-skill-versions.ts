/**
 * Generate `src/data/skill-versions.json` (bundle-only) from the skills/
 * source tree.
 *
 * Bundle versioning model — single source of truth in `skills/VERSION`.
 * No per-skill semver. The whole `skills/` directory ships as one
 * versioned bundle. The dashboard / CLI compare a single number to
 * detect drift.
 *
 * Run:
 *   pnpm skills:build
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, 'skills');
const OUT_PATH = join(ROOT, 'src/data/skill-versions.json');

function main(): void {
  const bundle = readFileSync(join(SKILLS_DIR, 'VERSION'), 'utf8').trim();

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        statSync(join(SKILLS_DIR, name, 'SKILL.md'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const out = { bundleVersion: bundle, skills: entries };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT_PATH} — bundle ${bundle}, ${entries.length} skills`);
}

main();
