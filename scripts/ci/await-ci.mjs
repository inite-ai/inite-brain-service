#!/usr/bin/env node
// Blocks until the CI workflow run for a given commit has finished, and
// fails if it did not finish green.
//
// WHY. deploy-brain.yml and ci.yml both fire on `push` to main, in
// parallel, with no ordering between them. The deploy therefore ships
// whatever the merge produced regardless of whether the tests agreed —
// a red main reached production, and the only thing standing between a
// broken merge and brain.inite.ai was how long the deploy's own build
// happened to take relative to the test suite.
//
// The obvious alternative is `on: workflow_run`, which hands you CI's
// conclusion for free. It is rejected here because workflow_run carries
// no `paths:` filter, and the deploy's path allowlist is a guarded,
// load-bearing thing (see test/deploy-trigger-truth.unit-spec.ts).
// Trading a tested trigger for an untested one to avoid ~40 lines of
// polling is a bad trade. So the trigger stays as it is and the deploy
// waits, explicitly, on a GitHub-hosted runner so the single self-hosted
// deploy runner is not held idle for the duration.
//
// Exit codes: 0 = CI succeeded, 1 = anything else (red, cancelled, timed
// out, never started). Fails closed in every case — "I could not tell"
// is not permission to deploy.

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const SHA = process.env.AWAIT_SHA;
const WORKFLOW = process.env.AWAIT_WORKFLOW ?? 'ci.yml';
const TIMEOUT_MIN = Number(process.env.AWAIT_TIMEOUT_MINUTES ?? '45');
const POLL_SECONDS = Number(process.env.AWAIT_POLL_SECONDS ?? '20');

function fail(message) {
  console.error(`[await-ci] ${message}`);
  process.exit(1);
}

if (!REPO) fail('GITHUB_REPOSITORY is not set');
if (!TOKEN) fail('GITHUB_TOKEN is not set');
if (!SHA) fail('AWAIT_SHA is not set');

const api = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${SHA}&per_page=20`;

async function latestRun() {
  const res = await fetch(api, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    // A transient 5xx must not be read as "no run exists"; the caller
    // retries, and only the overall deadline ends the wait.
    console.error(`[await-ci] GitHub API returned ${res.status}; retrying`);
    return null;
  }
  const body = await res.json();
  const runs = (body.workflow_runs ?? []).filter((r) => r.event === 'push');
  if (runs.length === 0) return null;
  // Newest first: a re-run replaces the verdict of the run it re-ran.
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return runs[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let announced = false;

  while (Date.now() < deadline) {
    const run = await latestRun().catch((err) => {
      console.error(`[await-ci] poll failed: ${err.message}; retrying`);
      return null;
    });

    if (run && !announced) {
      console.log(`[await-ci] watching ${run.html_url}`);
      announced = true;
    }

    if (run && run.status === 'completed') {
      const out = process.env.GITHUB_OUTPUT;
      if (out) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(out, `run_id=${run.id}\nconclusion=${run.conclusion}\n`);
      }
      if (run.conclusion === 'success') {
        console.log(`[await-ci] CI passed for ${SHA} (run ${run.id})`);
        process.exit(0);
      }
      fail(
        `CI concluded "${run.conclusion}" for ${SHA}. Not deploying. See ${run.html_url}`,
      );
    }

    if (!run) console.log(`[await-ci] no CI run for ${SHA} yet; waiting`);
    else console.log(`[await-ci] CI is ${run.status}; waiting`);

    await sleep(POLL_SECONDS * 1000);
  }

  fail(
    `timed out after ${TIMEOUT_MIN} min waiting for CI on ${SHA}. Not deploying — ` +
      'a deploy that cannot confirm its commit is green is the thing this gate exists to stop.',
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
