/**
 * Auto-bump the bundle version when any file under skills/<name>/**
 * changes. Single semver in skills/VERSION — no per-skill semvers.
 *
 * Modes:
 *   --staged         (default) git diff --cached vs HEAD
 *   --since=<ref>    git diff vs <ref>
 *   --dry-run        Report what would change but don't write
 *   --note "<text>"  CHANGELOG note (defaults to commit subject in CI)
 *
 * Bumps are always patch-level. Manual minor / major: edit
 * skills/VERSION, then `pnpm skills:build`.
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

interface Args {
  since: string | null;
  staged: boolean;
  dryRun: boolean;
  note: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { since: null, staged: false, dryRun: false, note: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--staged') out.staged = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--since') out.since = argv[++i] ?? null;
    else if (a.startsWith('--note=')) out.note = a.slice('--note='.length);
    else if (a === '--note') out.note = argv[++i] ?? null;
  }
  if (!out.since && !out.staged) out.staged = true;
  return out;
}

// argv array (not a shell string): `args.since` is a CLI value, so passing
// it as a discrete argument to execFileSync keeps it out of a shell and
// closes the command-injection vector.
function git(argv: string[]): string {
  return execFileSync('git', argv, { encoding: 'utf8' }).trim();
}

function changedFiles(args: Args): string[] {
  const argv = args.staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['diff', '--name-only', '--diff-filter=ACMR', args.since!];
  return git(argv).split('\n').filter(Boolean);
}

const SKIP_TOPLEVEL = new Set(['skills/VERSION', 'skills/CHANGELOG.md']);

function affectedSkills(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (!f.startsWith('skills/')) continue;
    if (SKIP_TOPLEVEL.has(f)) continue;
    const m = /^skills\/([^/]+)\//.exec(f);
    if (m) out.add(m[1]!);
  }
  return out;
}

function bumpPatch(semver: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(semver.trim());
  if (!m) throw new Error(`bumpPatch: not a semver: ${semver}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function bumpBundle(): { from: string; to: string } {
  const path = 'skills/VERSION';
  const from = readFileSync(path, 'utf8').trim();
  const to = bumpPatch(from);
  writeFileSync(path, to + '\n', 'utf8');
  return { from, to };
}

function appendChangelog(args: {
  bundle: { from: string; to: string };
  affected: string[];
  note: string;
}): void {
  const path = 'skills/CHANGELOG.md';
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`## [${args.bundle.to}] — ${today}`);
  lines.push('');
  if (args.note) lines.push(args.note);
  lines.push('');
  lines.push('### Changed skills');
  lines.push('');
  for (const name of args.affected) lines.push(`- \`${name}\``);
  lines.push('');

  const existing = readFileSync(path, 'utf8');
  const firstH2 = existing.indexOf('\n## ');
  if (firstH2 < 0) {
    writeFileSync(path, existing.trimEnd() + '\n\n' + lines.join('\n') + '\n', 'utf8');
    return;
  }
  const head = existing.slice(0, firstH2 + 1);
  const tail = existing.slice(firstH2 + 1);
  writeFileSync(path, head + lines.join('\n') + '\n' + tail, 'utf8');
}

function rebuildManifest(): void {
  execSync('pnpm tsx scripts/build-skill-versions.ts', { stdio: 'inherit' });
}

function defaultNote(args: Args): string {
  if (args.note) return args.note;
  if (args.since && args.since !== 'HEAD' && args.since !== '--cached') {
    try {
      return git(['log', '-1', '--pretty=%s']);
    } catch {
      /* ignore */
    }
  }
  return 'Uncommitted changes (auto-bump)';
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const files = changedFiles(args);
  if (files.length === 0) {
    console.log('bump-skill-versions: no changed files in scope');
    return;
  }
  const skills = affectedSkills(files);
  if (skills.size === 0) {
    console.log('bump-skill-versions: no skill content changed');
    return;
  }

  const list = [...skills].sort();
  console.log(`bump-skill-versions: affected (${list.length}): ${list.join(', ')}`);

  if (args.dryRun) {
    console.log('--dry-run set; not writing');
    return;
  }

  const bundle = bumpBundle();
  console.log(`bundle: ${bundle.from} → ${bundle.to}`);

  appendChangelog({ bundle, affected: list, note: defaultNote(args) });
  rebuildManifest();
}

main();
