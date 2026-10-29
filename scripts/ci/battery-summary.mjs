#!/usr/bin/env node
/**
 * Mean and range of every (battery, arm) across its samples, from the
 * downloaded battery artifacts. One sample of memory-fitness moves ±2–3
 * of 32 on the same code (2026-10-27: 29/27/30 on one main), so a single
 * number is noise; a base/head delta is worth reading only when it beats
 * both arms' ranges.
 *
 * Then the price of that quality. Pass counts alone call a flag that
 * halves the context at the price of a point a loss, and a flag that
 * doubles the bill at par free (2026-10-28: seven flags read "no gain" on
 * batteries near their ceiling, with no word on what each one cost). From
 * the `brain_llm_tokens` scrapes the workflow takes after the write half
 * and after the questions: write cost, context per question, answer
 * length, latency, dollars — and a verdict that accepts a small drift
 * bought with a multiple of economy.
 *
 * Usage: node scripts/ci/battery-summary.mjs <artifacts-dir>  → markdown
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * USD per 1M tokens, list prices (2026-09). An unknown model is priced as
 * the default chat model and marked `~`.
 */
const PRICES = {
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'text-embedding-3-small': { input: 0.02, cached: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, cached: 0.13, output: 0 },
};
const DEFAULT_PRICE = PRICES['gpt-6-luna'];

/** A cheaper arm may drift by this much of the battery and still win. */
const DRIFT_TOLERANCE = 0.05;
/** "A multiple of economy": the head costs at most this share of the base. */
const ECONOMY_RATIO = 0.5;

/** The generator reads the context pack; its input per question is the context. */
const CONTEXT_SITE = /^synthesize\/generator/;

const root = process.argv[2] ?? 'artifacts';
const cells = new Map();
let approxPrice = false;

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
  const key = `${battery}\u0000${arm}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push({ pass: s.pass, scored: s.pass + s.fail, ...price(out, report) });
}

/** Rows of `brain_llm_tokens{kind,model,site,type} value` → { "kind|model|site": {type: n} }. */
function readProm(path) {
  const acc = {};
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^brain_llm_tokens\{([^}]*)\} ([0-9.e+]+)$/.exec(line);
    if (!m) continue;
    const l = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const k = `${l.kind}|${l.model}|${l.site ?? 'unknown'}`;
    (acc[k] ??= {})[l.type] = Number(m[2]);
  }
  return acc;
}

function minus(a, b) {
  if (!b) return a;
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    out[k] = {};
    for (const [t, n] of Object.entries(v)) out[k][t] = Math.max(0, n - (b[k]?.[t] ?? 0));
  }
  return out;
}

function dollars(usage) {
  let usd = 0;
  let input = 0;
  let context = 0;
  let sawSites = false;
  const sites = {};
  for (const [k, v] of Object.entries(usage ?? {})) {
    const [kind, model, site] = k.split('|');
    const p = PRICES[model] ?? DEFAULT_PRICE;
    if (!PRICES[model]) approxPrice = true;
    const cached = v.cached_input ?? 0;
    const fresh = Math.max(0, (v.input ?? 0) - cached);
    const cost = (fresh * p.input + cached * p.cached + (v.output ?? 0) * p.output) / 1e6;
    usd += cost;
    if (kind === 'chat') input += v.input ?? 0;
    if (site && site !== 'unknown') sawSites = true;
    if (kind === 'chat' && CONTEXT_SITE.test(site ?? '')) context += v.input ?? 0;
    const row = (sites[`${kind}:${site}`] ??= { usd: 0, calls: 0, errors: 0 });
    row.usd += cost;
    row.calls += v.calls ?? 0;
    row.errors += v.errors ?? 0;
  }
  // Before per-site labels, all chat input stands in for the context.
  return { usd, input: sawSites ? context : input, sites };
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Everything a sample cost, and how long and wordy its answers were. */
function price(out, report) {
  const items =
    report.questions ?? report.probes ?? (report.results ?? []).flatMap((r) => r.checks ?? []);
  const answers = items.map((q) => q.answer).filter((a) => typeof a === 'string' && a.length > 0);
  const latencies = items.map((q) => q.latencyMs).filter((x) => typeof x === 'number');
  const write = readProm(join(out, 'usage-write.prom'));
  const end = readProm(join(out, 'usage-end.prom'));
  const hit = existsSync(join(out, 'snapshot-hit.txt'))
    ? readFileSync(join(out, 'snapshot-hit.txt'), 'utf8').trim() === 'true'
    : false;
  const ask = end ? (hit ? end : minus(end, write)) : null;
  const w = write ? dollars(write) : null;
  const a = ask ? dollars(ask) : null;
  const asked = Math.max(1, answers.length || items.length);
  return {
    writeSites: w?.sites,
    askSites: a?.sites,
    writeUsd: w?.usd,
    askUsd: a?.usd,
    ctxPerQ: a ? a.input / asked : undefined,
    answerChars: median(answers.map((x) => x.length)),
    latencyMs: median(latencies),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const defined = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));

const fmt = (xs) => {
  const ps = xs.map((x) => x.pass);
  return {
    mean: mean(ps),
    min: Math.min(...ps),
    max: Math.max(...ps),
    of: xs[0].scored,
    n: xs.length,
    writeUsd: mean(defined(xs.map((x) => x.writeUsd))),
    askUsd: mean(defined(xs.map((x) => x.askUsd))),
    ctxPerQ: mean(defined(xs.map((x) => x.ctxPerQ))),
    answerChars: mean(defined(xs.map((x) => x.answerChars))),
    latencyMs: mean(defined(xs.map((x) => x.latencyMs))),
  };
};

const batteries = [...new Set([...cells.keys()].map((k) => k.split('\u0000')[0]))].sort();
const quality = [
  '| battery | base mean [min–max] | head mean [min–max] | Δ | beats noise? |',
  '|---|---|---|---|---|',
];
const cost = [
  '| battery | arm | write $ | ask $ | context tok/question | answer chars (p50) | latency p50 | pass per $ |',
  '|---|---|---|---|---|---|---|---|',
];
const verdicts = [
  '| battery | quality Δ | cost head/base | context head/base | verdict |',
  '|---|---|---|---|---|',
];

const num = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : '—');
const ratio = (h, b) => (Number.isFinite(h) && Number.isFinite(b) && b > 0 ? h / b : NaN);

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
  quality.push(`| ${b} | ${cell(fb)} | ${cell(fh)} | ${delta} | ${beats} |`);
  for (const [arm, f] of [
    ['base', fb],
    ['head', fh],
  ]) {
    if (!f) continue;
    const total = f.writeUsd + f.askUsd;
    cost.push(
      `| ${b} | ${arm} | ${usd(f.writeUsd)} | ${usd(f.askUsd)} | ${num(f.ctxPerQ)} | ${num(f.answerChars)} | ${num(f.latencyMs / 1000, 1)} s | ${num(f.mean / total, 0)} |`,
    );
  }
  if (fb && fh) {
    const costR = ratio(fh.writeUsd + fh.askUsd, fb.writeUsd + fb.askUsd);
    const ctxR = ratio(fh.ctxPerQ, fb.ctxPerQ);
    verdicts.push(
      `| ${b} | ${delta} | ${num(costR, 2)}× | ${num(ctxR, 2)}× | ${verdict(fb, fh, beats, costR, ctxR)} |`,
    );
  }
}

/**
 * Quality first, then what it cost. A small drift (≤ DRIFT_TOLERANCE of
 * the battery) bought with a multiple of economy — total cost or the
 * context each answer reads — is a win: brevity is the sister of talent.
 */
function verdict(fb, fh, beats, costR, ctxR) {
  if (!Number.isFinite(costR))
    return beats === 'yes, better' ? 'better (cost unknown)' : `${beats} (cost unknown)`;
  const economy = Math.min(costR, Number.isFinite(ctxR) ? ctxR : Infinity);
  const smallDrift = fh.mean >= fb.mean - DRIFT_TOLERANCE * fb.of;
  if (beats === 'yes, better')
    return costR <= 1.1 ? '✅ better' : `better, at ${costR.toFixed(1)}× the cost — weigh`;
  if (smallDrift && economy <= ECONOMY_RATIO)
    return `✅ within drift, ${(1 / economy).toFixed(1)}× more economical`;
  if (beats === 'yes, worse') return '❌ worse';
  if (economy <= 0.8) return '✅ par, cheaper';
  if (costR >= 1.25) return '❌ par, costlier';
  return 'par';
}

process.stdout.write(
  `${quality.join('\n')}\n\n**Price of quality**\n\n${cost.join('\n')}\n\n${verdicts.join('\n')}\n`,
);
if (approxPrice)
  process.stdout.write(
    '\n~ some models are not in the price table and were priced as gpt-6-luna.\n',
  );

/**
 * Where the money goes: per calling file, mean dollars per sample in each
 * half, calls and errors — the audit view (a site that spends on the
 * write half of a corpus it never changes, or errors on every call, is
 * money for nothing).
 */
const where = [];
for (const [key, samples] of [...cells.entries()].sort()) {
  const [battery, arm] = key.split('\u0000');
  const agg = {};
  for (const smp of samples) {
    for (const [half, sites] of [
      ['write', smp.writeSites],
      ['ask', smp.askSites],
    ]) {
      for (const [site, r] of Object.entries(sites ?? {})) {
        const a = (agg[site] ??= { write: 0, ask: 0, calls: 0, errors: 0 });
        a[half] += r.usd / samples.length;
        a.calls += r.calls / samples.length;
        a.errors += r.errors / samples.length;
      }
    }
  }
  const rows = Object.entries(agg).sort((x, y) => y[1].write + y[1].ask - (x[1].write + x[1].ask));
  if (rows.length === 0) continue;
  const total = rows.reduce((t, [, r]) => t + r.write + r.ask, 0);
  where.push(`\n**${battery} · ${arm}** — $${total.toFixed(4)} per sample\n`);
  where.push('| site | write $ | ask $ | calls | errors | share |', '|---|---|---|---|---|---|');
  for (const [site, r] of rows) {
    const share = total > 0 ? (100 * (r.write + r.ask)) / total : 0;
    where.push(
      `| ${site} | ${usd(r.write)} | ${usd(r.ask)} | ${num(r.calls)} | ${num(r.errors)} | ${num(share)}% |`,
    );
  }
}
if (where.length) process.stdout.write(`\n**Where the money goes**\n${where.join('\n')}\n`);
