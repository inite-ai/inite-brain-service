import { execFileSync } from 'node:child_process';
import type { CommitInput } from './types';

/**
 * Read commits from a local git range into CommitInput[]. Squash-merge repos
 * (brain itself) fold the PR description into the commit body, so the message
 * alone carries the PR rationale — no GitHub API round-trip needed in Phase 1.
 *
 * `parseGitLog` is pure (unit-tested); `readCommits` is the thin git shell.
 */

// Field sep \x1f, record sep \x1e — neither appears in commit text. Format:
//   <RS><sha><FS><authorISO><FS><body><FS>\n<file>\n<file>...
const FS = '\x1f';
const RS = '\x1e';
const GIT_FORMAT = `${RS}%H${FS}%aI${FS}%B${FS}`;

export function parseGitLog(raw: string): CommitInput[] {
  const commits: CommitInput[] = [];
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    const [sha, authorDate, message, filesBlob = ''] = record.split(FS);
    if (!sha || !authorDate) continue;
    const changedFiles = filesBlob
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    commits.push({
      sha: sha.trim(),
      authorDate: authorDate.trim(),
      message: (message ?? '').trim(),
      changedFiles,
    });
  }
  return commits;
}

export function readCommits(opts: {
  range: string;
  cwd?: string;
}): CommitInput[] {
  const raw = execFileSync(
    'git',
    [
      'log',
      opts.range,
      '--no-merges',
      '--name-only',
      `--format=${GIT_FORMAT}`,
    ],
    { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseGitLog(raw);
}
