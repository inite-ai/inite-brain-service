#!/usr/bin/env node
/**
 * Mean and range of every (battery, arm) across its samples, from the
 * downloaded battery artifacts. One sample of memory-fitness moves ±2–3
 * of 32 on the same code (2026-10-27: 29/27/30 on one main), so a single
 * number is noise; a base/head delta is worth reading only when it beats
 * both arms' ranges.
 *
 * Usage: node scripts/ci/battery-summary.mjs <artifacts-dir>  → markdown
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'artifacts';
const cells = new Map();
for (const dir of existsSync(root) ? readdirSync(root) : []) {
  const m = /^batteries-(base|head)-(.+)-(\d+)$/.exec(dir);
  if (!m) continue;
  const [, arm, battery] = m;
  const out = join(root, dir, 'out');
  if (!existsSync(out)) continue;
  const file = readdirSync(out).find((f) => f.startsWith(`${battery}-`) && f.endsWith('.json'));
  if (!file) continue;
  const report = JSON.parse(readFileSync(join(out, file), 'utf8'));
  const s = report.overall ?? report.checks;
  if (!s || typeof s.pass !== 'number') continue;
  const scored = s.pass + s.fail;
  const key = `${battery}\u0000${arm}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push({ pass: s.pass, scored });
}

const fmt = (xs) => {
  const ps = xs.map((x) => x.pass);
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  return { mean, min: Math.min(...ps), max: Math.max(...ps), of: xs[0].scored, n: xs.length };
};

const lines = ['| battery | base mean [min–max] | head mean [min–max] | Δ | beats noise? |', '|---|---|---|---|---|'];
const batteries = [...new Set([...cells.keys()].map((k) => k.split('\u0000')[0]))].sort();
for (const b of batteries) {
  const base = cells.get(`${b}\u0000base`);
  const head = cells.get(`${b}\u0000head`);
  const cell = (x) => (x ? `${x.mean.toFixed(1)}/${x.of} [${x.min}–${x.max}] n=${x.n}` : '—');
  const fb = base && fmt(base);
  const fh = head && fmt(head);
  let delta = '—';
  let beats = '—';
  if (fb && fh) {
    delta = (fh.mean - fb.mean).toFixed(1);
    beats =
      fb.n < 2 || fh.n < 2
        ? 'unknown (one sample)'
        : fh.min > fb.max
          ? 'yes, better'
          : fh.max < fb.min
            ? 'yes, worse'
            : 'no (ranges overlap)';
  }
  lines.push(`| ${b} | ${cell(fb)} | ${cell(fh)} | ${delta} | ${beats} |`);
}
process.stdout.write(`${lines.join('\n')}\n`);
