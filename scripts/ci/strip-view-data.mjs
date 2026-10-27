#!/usr/bin/env node
// Make a `surreal export` dump importable: drop the rows of computed
// views (DEFINE TABLE … AS SELECT, e.g. the stats views of migration
// 0088). Importing the definition makes the view compute itself, and the
// dump's own copy of those rows then fails with "record already exists".
// Definitions and every ordinary table are kept as they are.
//
//   node scripts/ci/strip-view-data.mjs <in.surql> <out.surql>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: strip-view-data.mjs <in.surql> <out.surql>');
  process.exit(2);
}

const dump = readFileSync(input, 'utf8');
const views = new Set(
  [...dump.matchAll(/^DEFINE TABLE (?:OVERWRITE |IF NOT EXISTS )?(\S+) .*\bAS SELECT\b/gm)].map(
    (m) => m[1],
  ),
);

// The dump is a sequence of sections, each opened by a three-line banner:
//   -- ------------------------------
//   -- TABLE DATA: <name>
//   -- ------------------------------
const BANNER = '-- ------------------------------\n';
const parts = dump.split(BANNER);
const kept = [];
let dropped = 0;
for (let i = 0; i < parts.length; i++) {
  const title = /^-- TABLE DATA: (\S+)\n$/.exec(parts[i] ?? '');
  if (title && views.has(title[1])) {
    // skip the title, and the body after the closing banner line
    i += 1;
    dropped += 1;
    continue;
  }
  kept.push(parts[i]);
}

writeFileSync(output, kept.join(BANNER));
console.log(`[snap] ${views.size} view(s), ${dropped} view data section(s) dropped`);
