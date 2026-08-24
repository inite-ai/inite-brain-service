#!/usr/bin/env -S npx ts-node -T
/**
 * mri-record-suite — record a STRUCTURAL MRI dimension's suite pass status into
 * the ledger (docs/mri/suite-status.json) from a REAL Jest run.
 *
 * This is the only writer of the ledger. It is FAIL-CLOSED: a recorded `pass`
 * ALWAYS corresponds to a real green run of the REAL, canonical suite —
 *   - the suite key is pinned to its file(s) internally (src/mri/suite-status.ts);
 *     there is NO `--files` override, so a suite cannot be substituted;
 *   - a non-zero Jest exit is NEVER recorded as a pass (it records `fail`, or
 *     refuses to write when the run produced no parseable result / no tests);
 *   - an exit-0 run that executed ZERO tests is refused (a vacuous pass is not a
 *     pass);
 *   - `--gap` must be a bounded non-negative integer.
 * No hand-editing. The MRI report reads the ledger for premise-awareness /
 * poisoning-resistance / tenant-user-isolation and renders whatever the last
 * real run recorded.
 *
 * Run:
 *   pnpm mri:record-suite tenant-user-isolation --config test/jest-unit.json
 *   pnpm mri:record-suite minja-redteam --config test/jest-e2e.json --gap 0
 *
 * Flags:
 *   --config <path>   Jest config (default test/jest-unit.json)
 *   --gap <n>         Domain gap count to record (non-negative integer, ≤ 10000)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ALL_SUITE_SPECS,
  DEFAULT_LEDGER_PATH,
  type SuiteLedger,
  type SuiteLedgerEntry,
} from '../src/mri/suite-status';

/** Upper bound on `--gap` — a domain gap count is small (e.g. MINJA GAP count). */
export const MAX_GAP = 10_000;

export interface Args {
  key: string;
  config: string;
  gap?: number;
}

function parseGap(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--gap must be a non-negative integer, got '${raw}'`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_GAP) {
    throw new Error(`--gap out of range [0, ${MAX_GAP}], got '${raw}'`);
  }
  return n;
}

/**
 * Parse argv. Rejects unknown/unsupported flags — in particular `--files`, which
 * used to allow substituting a canonical suite's file list (a false-green vector).
 * Canonical suites are pinned to their files in src/mri/suite-status.ts.
 */
export function parseArgs(argv: string[]): Args {
  const key = argv[0];
  if (!key || key.startsWith('--')) {
    throw new Error('usage: mri:record-suite <suiteKey> [--config <path>] [--gap <n>]');
  }
  const out: Args = { key, config: 'test/jest-unit.json' };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--config') {
      if (val === undefined || val.startsWith('--')) throw new Error('--config requires a path');
      out.config = val;
      i += 1;
    } else if (flag === '--gap') {
      if (val === undefined) throw new Error('--gap requires a value');
      out.gap = parseGap(val);
      i += 1;
    } else {
      throw new Error(
        `unknown or unsupported flag '${flag ?? ''}' — canonical suites are pinned to their files ` +
          'in src/mri/suite-status.ts; `--files` suite substitution is not allowed',
      );
    }
  }
  return out;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

export interface JestJson {
  success: boolean;
  numPassedTests: number;
  numFailedTests: number;
}

/** A Jest invocation's outcome: its process exit code + parsed --json (or null). */
export interface JestRun {
  exitCode: number;
  json: JestJson | null;
}

function parseJestJson(stdout: string): JestJson | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as JestJson;
  } catch {
    return null;
  }
}

function runJest(config: string, files: string[]): JestRun {
  // Patterns must override the worktree ignore defaults (jest configs ignore
  // /.claude/worktrees/, which would otherwise skip everything here).
  const pattern = files.map((f) => f.replace(/[.]/g, '\\.')).join('|');
  const args = [
    'jest',
    '--config',
    config,
    '--json',
    `--testPathPatterns=${pattern}`,
    '--testPathIgnorePatterns',
    '/node_modules/',
    '--modulePathIgnorePatterns',
    '/node_modules/',
  ];
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // Jest exits non-zero on failing tests (JSON still on stdout) OR crashes
    // (no/garbage JSON). Capture the ACTUAL exit code — it is the load-bearing
    // signal: a non-zero exit is never recorded as a pass.
    const e = err as { status?: number | null; stdout?: string | Buffer };
    exitCode = typeof e.status === 'number' ? e.status : 1;
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
  }
  return { exitCode, json: parseJestJson(stdout) };
}

/**
 * Turn a Jest run into a ledger entry — FAIL-CLOSED. A `pass` requires ALL of:
 * exit code 0, `success`, zero failed tests, and at least one PASSED test (a
 * run that matched no tests is not a pass). Any other exit-0 shape, and every
 * unparseable / no-tests-executed run, THROWS (refuse to write). A non-zero exit
 * with real failures records `fail`. So the ledger never gains a false green.
 */
export function decideEntry(
  run: JestRun,
  opts: { gap?: number; commit?: string; now?: Date } = {},
): SuiteLedgerEntry {
  const recordedAt = (opts.now ?? new Date()).toISOString();
  const extra = {
    ...(opts.commit ? { commit: opts.commit } : {}),
    ...(opts.gap !== undefined ? { gapCount: opts.gap } : {}),
  };

  if (run.json === null) {
    throw new Error(
      `refusing to record: could not parse Jest --json output (exit ${run.exitCode}) — the suite ` +
        'produced no result, so neither pass nor fail can be attested',
    );
  }
  const { success, numPassedTests, numFailedTests } = run.json;
  const ranTests = numPassedTests + numFailedTests;

  if (run.exitCode === 0) {
    if (!success || numFailedTests > 0 || numPassedTests === 0) {
      throw new Error(
        `refusing to record a pass: exit 0 but success=${success}, passed=${numPassedTests}, ` +
          `failed=${numFailedTests} — a pass must be a real green run of real tests`,
      );
    }
    return {
      status: 'pass',
      numPassed: numPassedTests,
      numFailed: numFailedTests,
      recordedAt,
      ...extra,
    };
  }

  // Non-zero exit → NEVER a pass.
  if (ranTests === 0) {
    throw new Error(
      `refusing to record: Jest exited ${run.exitCode} with no tests executed (crash / no match) — ` +
        'not a real fail either',
    );
  }
  return {
    status: 'fail',
    numPassed: numPassedTests,
    numFailed: numFailedTests,
    recordedAt,
    note: `jest exited ${run.exitCode}`,
    ...extra,
  };
}

function loadLedger(path: string): SuiteLedger {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SuiteLedger;
  } catch {
    return {};
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const spec = ALL_SUITE_SPECS.find((s) => s.key === args.key);
  if (!spec) {
    throw new Error(
      `unknown suite key '${args.key}' — canonical keys: ${ALL_SUITE_SPECS.map((s) => s.key).join(', ')}`,
    );
  }
  if (!existsSync(args.config)) {
    throw new Error(`Jest config not found: ${args.config}`);
  }

  const run = runJest(args.config, spec.files);
  const commit = gitCommit();
  const entry = decideEntry(run, {
    ...(args.gap !== undefined ? { gap: args.gap } : {}),
    ...(commit ? { commit } : {}),
  });

  const ledger = loadLedger(DEFAULT_LEDGER_PATH);
  ledger[args.key] = entry;
  mkdirSync(dirname(DEFAULT_LEDGER_PATH), { recursive: true });
  writeFileSync(DEFAULT_LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `recorded ${args.key}: ${entry.status} (${entry.numPassed}/${entry.numFailed}) → ${DEFAULT_LEDGER_PATH}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`✗ mri:record-suite failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
