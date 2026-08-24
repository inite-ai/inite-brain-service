#!/usr/bin/env -S npx ts-node -T
/**
 * mri-record-suite — record a STRUCTURAL MRI dimension's suite pass status into
 * the ledger (docs/mri/suite-status.json) from a REAL Jest run.
 *
 * This is the only writer of the ledger. A `pass` is therefore always backed by
 * an actual green run at a named commit — never hand-edited, never guessed. The
 * MRI report reads the ledger for premise-awareness / poisoning-resistance /
 * tenant-user-isolation and renders whatever the last real run recorded.
 *
 * Run:
 *   pnpm mri:record-suite tenant-user-isolation --config test/jest-unit.json
 *   pnpm mri:record-suite minja-redteam --config test/jest-e2e.json --gap 0
 *
 * Flags:
 *   --config <path>   Jest config (default test/jest-unit.json)
 *   --gap <n>         Domain gap count to record (e.g. MINJA GAP count)
 *   --files a,b       Override the suite file list (comma-separated)
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

interface Args {
  key: string;
  config: string;
  gap?: number;
  files?: string[];
}

function parseArgs(argv: string[]): Args {
  const key = argv[0];
  if (!key || key.startsWith('--')) {
    throw new Error(
      'usage: mri:record-suite <suiteKey> [--config <path>] [--gap <n>] [--files a,b]',
    );
  }
  const out: Args = { key, config: 'test/jest-unit.json' };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--config' && val) {
      out.config = val;
      i += 1;
    } else if (flag === '--gap' && val) {
      out.gap = Number(val);
      i += 1;
    } else if (flag === '--files' && val) {
      out.files = val.split(',').map((s) => s.trim());
      i += 1;
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

interface JestJson {
  success: boolean;
  numPassedTests: number;
  numFailedTests: number;
}

function runJest(config: string, files: string[]): JestJson {
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
  try {
    stdout = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // Jest exits non-zero on failing tests; the JSON is still on stdout.
    const e = err as { stdout?: string | Buffer };
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
  }
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`could not parse Jest --json output for ${files.join(',')}`);
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as JestJson;
  return parsed;
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
  const files = args.files ?? spec?.files;
  if (!files || files.length === 0) {
    throw new Error(`unknown suite key '${args.key}' and no --files given`);
  }

  const result = runJest(args.config, files);
  const commit = gitCommit();
  const entry: SuiteLedgerEntry = {
    status: result.success ? 'pass' : 'fail',
    numPassed: result.numPassedTests,
    numFailed: result.numFailedTests,
    recordedAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    ...(args.gap !== undefined ? { gapCount: args.gap } : {}),
  };

  const ledger = loadLedger(DEFAULT_LEDGER_PATH);
  ledger[args.key] = entry;
  mkdirSync(dirname(DEFAULT_LEDGER_PATH), { recursive: true });
  writeFileSync(DEFAULT_LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  process.stdout.write(
    `recorded ${args.key}: ${entry.status} (${entry.numPassed}/${entry.numFailed}) → ${DEFAULT_LEDGER_PATH}\n`,
  );
}

main();
