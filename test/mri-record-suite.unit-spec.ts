/**
 * mri:record-suite recorder — FAIL-CLOSED guarantees (scripts/mri-record-suite.ts).
 *
 * A recorded `pass` must correspond to a REAL green run of the REAL canonical
 * suite. These specs pin the three hardening properties as pure-function unit
 * tests (no Jest child process spawned):
 *   - a non-zero Jest exit is never a pass (records `fail`, or refuses);
 *   - `--files` suite substitution is rejected;
 *   - a bad `--gap` is rejected.
 * Importing the script must NOT execute its `main()` — it is guarded by
 * `require.main === module`, the same idiom as scripts/init-pack.ts.
 */
import {
  parseArgs,
  decideEntry,
  exitCodeForEntry,
  MAX_GAP,
  type JestRun,
} from '../scripts/mri-record-suite';
import type { SuiteLedgerEntry } from '../src/mri/suite-status';

const NOW = new Date('2026-08-24T00:00:00.000Z');

describe('parseArgs — fail-closed flag handling', () => {
  it('rejects a `--files` override of a canonical suite (suite substitution)', () => {
    expect(() =>
      parseArgs(['tenant-user-isolation', '--files', 'test/some-other.spec.ts']),
    ).toThrow(/--files|unsupported flag/);
  });

  it('rejects any unknown flag (typo guard)', () => {
    expect(() => parseArgs(['minja-redteam', '--bogus', 'x'])).toThrow(/unknown or unsupported/);
  });

  it('rejects a negative --gap', () => {
    expect(() => parseArgs(['minja-redteam', '--gap', '-1'])).toThrow(/non-negative integer/);
  });

  it('rejects a non-integer --gap', () => {
    expect(() => parseArgs(['minja-redteam', '--gap', '1.5'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['minja-redteam', '--gap', 'abc'])).toThrow(/non-negative integer/);
  });

  it('rejects an out-of-range --gap', () => {
    expect(() => parseArgs(['minja-redteam', '--gap', String(MAX_GAP + 1)])).toThrow(
      /out of range/,
    );
  });

  it('accepts a valid key + config + gap', () => {
    const args = parseArgs(['minja-redteam', '--config', 'test/jest-e2e.json', '--gap', '0']);
    expect(args).toEqual({ key: 'minja-redteam', config: 'test/jest-e2e.json', gap: 0 });
  });

  it('requires a suite key (not a flag)', () => {
    expect(() => parseArgs(['--config', 'x'])).toThrow(/usage/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });
});

describe('decideEntry — a pass is only ever a real green run', () => {
  const green: JestRun = {
    exitCode: 0,
    json: { success: true, numPassedTests: 6, numFailedTests: 0 },
  };

  it('records a pass for a green run', () => {
    const entry = decideEntry(green, { now: NOW, commit: 'abc1234' });
    expect(entry.status).toBe('pass');
    expect(entry.numPassed).toBe(6);
    expect(entry.numFailed).toBe(0);
    expect(entry.commit).toBe('abc1234');
  });

  it('records FAIL (never pass) on a non-zero Jest exit with real failures', () => {
    const failed: JestRun = {
      exitCode: 1,
      json: { success: false, numPassedTests: 4, numFailedTests: 2 },
    };
    const entry = decideEntry(failed, { now: NOW });
    expect(entry.status).toBe('fail');
    expect(entry.numFailed).toBe(2);
    expect(entry.note).toMatch(/exited 1/);
  });

  it('REFUSES to record a vacuous exit-0 pass that ran zero tests', () => {
    const noTests: JestRun = {
      exitCode: 0,
      json: { success: true, numPassedTests: 0, numFailedTests: 0 },
    };
    expect(() => decideEntry(noTests, { now: NOW })).toThrow(/real green run of real tests/);
  });

  it('REFUSES when Jest crashed (non-zero exit, no tests executed)', () => {
    const crash: JestRun = {
      exitCode: 2,
      json: { success: false, numPassedTests: 0, numFailedTests: 0 },
    };
    expect(() => decideEntry(crash, { now: NOW })).toThrow(/no tests executed/);
  });

  it('REFUSES when the Jest --json output could not be parsed', () => {
    const unparseable: JestRun = { exitCode: 1, json: null };
    expect(() => decideEntry(unparseable, { now: NOW })).toThrow(/could not parse/);
  });

  it('carries a validated gap onto the entry', () => {
    const entry = decideEntry(green, { now: NOW, gap: 0 });
    expect(entry.gapCount).toBe(0);
  });
});

describe('exitCodeForEntry — FAIL-CLOSED process exit (R3 P1)', () => {
  it('exits 0 only for a recorded pass', () => {
    const pass: SuiteLedgerEntry = {
      status: 'pass',
      numPassed: 6,
      numFailed: 0,
      recordedAt: NOW.toISOString(),
    };
    expect(exitCodeForEntry(pass)).toBe(0);
  });

  it('exits NON-ZERO on a recorded fail — a red suite never greens the process', () => {
    const fail: SuiteLedgerEntry = {
      status: 'fail',
      numPassed: 4,
      numFailed: 2,
      recordedAt: NOW.toISOString(),
      note: 'jest exited 1',
    };
    expect(exitCodeForEntry(fail)).toBe(1);
    // End-to-end: decideEntry turns a red Jest run into a `fail` entry, and
    // exitCodeForEntry turns that into a non-zero exit — so the recorder cannot
    // record `fail` yet exit 0 (the leak #343 left behind).
    const redRun: JestRun = {
      exitCode: 1,
      json: { success: false, numPassedTests: 4, numFailedTests: 2 },
    };
    const entry = decideEntry(redRun, { now: NOW });
    expect(entry.status).toBe('fail');
    expect(exitCodeForEntry(entry)).toBe(1);
  });
});
