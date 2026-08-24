import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Suite-status ledger — the honest backbone of the STRUCTURAL MRI dimensions
 * (premise-awareness, poisoning-resistance, tenant/user isolation).
 *
 * These dimensions are not live per-request numbers; they are "verified by
 * suite X, last recorded status Y". A structural dimension NEVER claims a pass
 * on its own — it reports exactly what the ledger records, and the ledger is
 * written ONLY by `scripts/mri-record-suite.ts` from a real Jest run (exit code
 * + `--json` counts). No hand-editing, so a `pass` is always backed by an
 * actual green run at a named commit. Absent entry → the report says
 * `unrecorded` with the recorder command, never a guessed status.
 */

export interface SuiteLedgerEntry {
  status: 'pass' | 'fail';
  /** Passed/failed test counts as reported by Jest. */
  numPassed?: number;
  numFailed?: number;
  /** Domain-specific gap count (e.g. the MINJA red-team GAP count). */
  gapCount?: number;
  /** ISO timestamp the run was recorded. */
  recordedAt: string;
  /** Git commit the run was recorded at (staleness marker). */
  commit?: string;
  note?: string;
}

export type SuiteLedger = Record<string, SuiteLedgerEntry>;

/** Committed ledger path (produced by `pnpm mri:record-suite`, read at report time). */
export const DEFAULT_LEDGER_PATH = join('docs', 'mri', 'suite-status.json');

export function loadSuiteLedger(path: string = DEFAULT_LEDGER_PATH): SuiteLedger {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SuiteLedger;
    }
  } catch {
    // Malformed ledger → treat as empty; the report renders `unrecorded`
    // rather than crashing or inventing a status.
  }
  return {};
}

/** A structural dimension's binding to the suite(s) that establish it. */
export interface SuiteSpec {
  /** Stable ledger key + report dimension binding. */
  key: string;
  /** Canonical suite file(s), named in the dimension's `source`. */
  files: string[];
  /** Optional design-doc reference. */
  doc?: string;
}

export const PREMISE_SUITE: SuiteSpec = {
  key: 'memtrap-shakedown',
  files: ['test/memtrap-shakedown.e2e-spec.ts'],
  doc: 'docs/roadmap/memtrap-shakedown-2026-08.md',
};

export const POISONING_SUITE: SuiteSpec = {
  key: 'minja-redteam',
  files: ['test/memory-injection-redteam.e2e-spec.ts'],
  doc: 'docs/roadmap/sota-gap-build-2026-08.md',
};

export const ISOLATION_SUITE: SuiteSpec = {
  key: 'tenant-user-isolation',
  files: [
    'test/user-scope.e2e-spec.ts',
    'test/user-scope.unit-spec.ts',
    'test/l0-user-scope.unit-spec.ts',
    'test/artifacts-user-scope.e2e-spec.ts',
  ],
};

export const ALL_SUITE_SPECS: SuiteSpec[] = [PREMISE_SUITE, POISONING_SUITE, ISOLATION_SUITE];
