/**
 * The repository read surface: a bounded working-tree walk plus a thin
 * `git` subprocess shell. Deliberately an INTERFACE with one filesystem
 * implementation — every deriver takes a `RepoSource`, so the unit suite
 * drives them from an in-memory fixture with no `git` binary and no
 * temp-directory choreography.
 *
 * No new runtime dependency: history is read by shelling out to the
 * `git` already required to have produced the checkout, exactly as
 * `src/code-memory/capture/git-commits.ts` does. `simple-git` and
 * friends would buy nothing but supply-chain surface.
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SKIP_DIRS } from './types';

export interface RepoFileRef {
  /** Repo-relative POSIX path. */
  path: string;
  bytes: number;
}

export interface CommitRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  date: string;
  /** Full commit message (subject + body), verbatim. */
  message: string;
  changedFiles: string[];
}

export interface RepoSource {
  /** Scannable working-tree files — filtered, size-capped, binary-free. */
  listFiles(): RepoFileRef[];
  /** File text, or null when unreadable. */
  readFile(path: string): string | null;
  /** Commits newest-first. `since` is an exclusive lower-bound commit-ish. */
  readCommits(opts: { since?: string | undefined; limit: number }): CommitRecord[];
  /** HEAD sha, or null outside a git checkout. */
  head(): string | null;
  /**
   * Paths changed in `since..HEAD`, or null when the delta cannot be
   * computed (no git, unknown commit-ish) — the caller then falls back
   * to a full walk rather than silently indexing nothing.
   */
  changedSince(since: string): string[] | null;
}

// Field/record separators: neither appears in commit text (git-commits.ts).
const FS_SEP = '\x1f';
const RS_SEP = '\x1e';
const GIT_FORMAT = `${RS_SEP}%H${FS_SEP}%an${FS_SEP}%ae${FS_SEP}%aI${FS_SEP}%B${FS_SEP}`;

/** Dot-directories that carry real repository artefacts. */
const ALLOWED_DOT_DIRS = new Set(['.github']);

/** Pure: parse `git log --name-only` output in the format above. */
export function parseCommitLog(raw: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const record of raw.split(RS_SEP)) {
    if (!record.trim()) continue;
    const [sha, authorName, authorEmail, date, message, filesBlob = ''] = record.split(FS_SEP);
    if (!sha?.trim() || !date?.trim()) continue;
    commits.push({
      sha: sha.trim(),
      authorName: (authorName ?? '').trim(),
      authorEmail: (authorEmail ?? '').trim(),
      date: date.trim(),
      message: (message ?? '').trim(),
      changedFiles: filesBlob
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    });
  }
  return commits;
}

/** True when the first 8KiB carries a NUL byte — the usual binary tell. */
function looksBinary(absPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(8_192);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface FsRepoSourceOptions {
  root: string;
  maxFiles: number;
  maxFileBytes: number;
}

/** Working tree + `git` subprocess implementation of {@link RepoSource}. */
export class FsRepoSource implements RepoSource {
  private cachedFiles: RepoFileRef[] | undefined;

  constructor(private readonly opts: FsRepoSourceOptions) {}

  listFiles(): RepoFileRef[] {
    if (this.cachedFiles) return this.cachedFiles;
    const out: RepoFileRef[] = [];
    this.walk(this.opts.root, out);
    this.cachedFiles = out;
    return out;
  }

  readFile(path: string): string | null {
    try {
      return readFileSync(join(this.opts.root, path), 'utf8');
    } catch {
      return null;
    }
  }

  head(): string | null {
    return this.git(['rev-parse', 'HEAD'])?.trim() ?? null;
  }

  readCommits(opts: { since?: string | undefined; limit: number }): CommitRecord[] {
    const range = opts.since ? [`${opts.since}..HEAD`] : [];
    const raw = this.git([
      'log',
      ...range,
      '--no-merges',
      '--name-only',
      `--max-count=${Math.max(1, Math.trunc(opts.limit))}`,
      `--format=${GIT_FORMAT}`,
    ]);
    return raw === null ? [] : parseCommitLog(raw);
  }

  changedSince(since: string): string[] | null {
    const raw = this.git(['diff', '--name-only', `${since}..HEAD`]);
    if (raw === null) return null;
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** One `git` invocation; null on any failure (no git, bad ref, no repo). */
  private git(args: string[]): string | null {
    try {
      return execFileSync('git', args, {
        cwd: this.opts.root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  }

  private walk(dir: string, out: RepoFileRef[]): void {
    if (out.length >= this.opts.maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= this.opts.maxFiles) return;
      const abs = join(dir, entry.name);
      // Symlinks are never followed: a link out of the tree would escape
      // every cap and could re-enter the tree in a cycle.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(entry.name)) continue;
        this.walk(abs, out);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes: number;
      try {
        bytes = statSync(abs).size;
      } catch {
        continue;
      }
      if (bytes === 0 || bytes > this.opts.maxFileBytes) continue;
      if (looksBinary(abs)) continue;
      out.push({ path: relative(this.opts.root, abs).split(sep).join('/'), bytes });
    }
  }
}
