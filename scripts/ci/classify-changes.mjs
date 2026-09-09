#!/usr/bin/env node
// CI entrypoint for change detection. Reads the changed-file list on stdin
// (one path per line, as `git diff --name-only` emits it), writes the job
// selection booleans to $GITHUB_OUTPUT, and prints the per-file reasoning
// to the log so a skipped gate is always explainable after the fact.
//
// Exits non-zero only on a real failure (missing $GITHUB_OUTPUT). A
// classification is never a failure — every path classifies, because the
// default bucket is "engine", i.e. run everything.

import { appendFileSync, readFileSync } from 'node:fs';
import { classifyChanges } from './change-buckets.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const files = readStdin()
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const { engine, web, reasons } = classifyChanges(files);

console.log(`[ci] ${files.length} changed file(s)`);
for (const reason of reasons) console.log(`[ci]   ${reason}`);
console.log(`[ci] engine=${engine} web=${web}`);

const out = process.env.GITHUB_OUTPUT;
if (!out) {
  console.error('[ci] GITHUB_OUTPUT is not set — cannot publish job selection');
  process.exit(1);
}
appendFileSync(out, `engine=${engine}\nweb=${web}\n`);
