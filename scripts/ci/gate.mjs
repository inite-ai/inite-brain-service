#!/usr/bin/env node
// The `build-test` aggregating gate.
//
// WHY THIS FILE EXISTS. Branch protection on main requires four status
// checks BY NAME: build-test, supply-chain, trufflehog, lint. Only a repo
// admin can change that list. Sharding the old monolithic `build-test` job
// into real parallel jobs would delete the required check — and GitHub's
// failure mode there is the dangerous one: the branch stops requiring the
// gate rather than blocking on it, so PRs merge ungated and nothing says
// so. The name therefore stays, attached to a job that runs no tests and
// only judges the jobs that do.
//
// THE HARD PART is that GitHub reports `skipped` for two opposite reasons:
//   (a) the job's own `if:` was false     — not relevant to this change,
//                                            and the gate must PASS on it;
//   (b) something it `needs:` failed or   — the job never got to run, and
//       was itself skipped                  the gate must FAIL on it.
// `needs.<job>.result` is identical in both cases, so a gate that only
// reads results cannot tell them apart, and the naive `contains(needs.*.result,
// 'failure')` idiom passes case (b) — a silently ungated merge.
//
// The disambiguation is to check the result against an EXPECTATION derived
// from the same change-detection outputs the job's own `if:` used. Expected
// to run => must be 'success'. Not expected => must be 'skipped'. A job that
// was expected and came back 'skipped' is case (b) and fails the gate.
//
// The expectation table below duplicates each job's `if:` condition, and
// duplication rots. test/ci-gate-truth.unit-spec.ts parses ci.yml and fails
// if the table and the YAML disagree, if a job exists that the gate does not
// judge, or if the gate judges a job that no longer exists.

/**
 * Which change-detection output each job's `if:` gates on.
 * `null` means the job has no `if:` and must always run.
 */
export const EXPECTATIONS = {
  'engine-checks': 'engine',
  'engine-unit': 'engine',
  'engine-socket': 'engine',
  'engine-e2e': 'engine',
  'engine-jobs-e2e': 'engine',
  docker: 'engine',
  web: 'web',
};

const OK = 'success';
const SKIPPED = 'skipped';

/**
 * Pure verdict function. `needs` is the parsed `toJSON(needs)` object,
 * `selection` is `{ engine: boolean, web: boolean }`.
 * Returns { ok, rows } where rows describe every judged job.
 */
export function judge(needs, selection) {
  const rows = [];

  for (const [job, bucket] of Object.entries(EXPECTATIONS)) {
    const result = needs[job]?.result ?? 'missing';
    const expected = bucket === null ? true : selection[bucket] === true;
    const want = expected ? OK : SKIPPED;
    // A not-expected job that ran anyway and passed is fine — change
    // detection being conservative is never a gate failure. The reverse
    // (expected, did not run) is exactly case (b) and is fatal.
    const ok = expected ? result === OK : result === SKIPPED || result === OK;
    rows.push({ job, expected, want, result, ok });
  }

  // `changes` itself has no expectation — if it failed, nothing downstream
  // is trustworthy and every other row is meaningless.
  const changesResult = needs.changes?.result ?? 'missing';
  const changesOk = changesResult === OK;
  rows.unshift({
    job: 'changes',
    expected: true,
    want: OK,
    result: changesResult,
    ok: changesOk,
  });

  return { ok: rows.every((r) => r.ok), rows };
}

function main() {
  const needsRaw = process.env.GATE_NEEDS;
  const engine = process.env.GATE_ENGINE === 'true';
  const web = process.env.GATE_WEB === 'true';

  if (!needsRaw) {
    console.error('[gate] GATE_NEEDS is empty — the gate cannot judge anything. Failing closed.');
    process.exit(1);
  }

  let needs;
  try {
    needs = JSON.parse(needsRaw);
  } catch (err) {
    console.error(`[gate] GATE_NEEDS is not valid JSON: ${err.message}. Failing closed.`);
    process.exit(1);
  }

  const { ok, rows } = judge(needs, { engine, web });

  console.log(`[gate] change selection: engine=${engine} web=${web}`);
  console.log('[gate] job                 expected  want      got');
  for (const row of rows) {
    const mark = row.ok ? 'ok ' : 'ERR';
    console.log(
      `[gate] ${mark} ${row.job.padEnd(18)} ${String(row.expected).padEnd(9)} ${row.want.padEnd(9)} ${row.result}`,
    );
  }

  if (ok) {
    console.log('[gate] every required job reported the result its relevance demanded.');
    process.exit(0);
  }

  console.error('[gate] FAILED. A job either did not pass, or was expected to run and did not.');
  console.error('[gate] A job expected=true that came back "skipped" means one of its');
  console.error('[gate] dependencies failed — look upstream, not at the gate.');
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('gate.mjs')) main();
