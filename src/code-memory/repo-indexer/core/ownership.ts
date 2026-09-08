/**
 * `code_memory__owns` — who is responsible for a path.
 *
 * Two sources, in strict precedence:
 *
 *   1. CODEOWNERS. A declared owner is a STATEMENT by the repository, so
 *      it is quoted verbatim and needs no inference at all.
 *   2. Git-history concentration, used only when the repo declares no
 *      CODEOWNERS. Authorship concentration is evidence of stewardship,
 *      not a declaration — so it is emitted at lower confidence and the
 *      emitted fact carries the RULE ("dominant author of N commits
 *      touching this path over the last M") in its derivation. Brain
 *      stores why the indexer believed it, never a bare assertion.
 *
 * The history rule refuses to guess: a path needs `ownershipMinCommits`
 * commits and a dominant author holding `ownershipMinShare` of them, or
 * no fact is emitted.
 */
import type { CommitRecord, RepoSource } from '../repo-source';
import type { IndexerCaps, RepoFact } from '../types';

/** Conventional CODEOWNERS locations, in the order git itself checks. */
const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

export interface CodeownersRule {
  /** 1-based line number in the CODEOWNERS file. */
  line: number;
  /** The raw line, verbatim. */
  raw: string;
  /** Path-shaped pattern, normalized (no leading/trailing slash). */
  path: string;
  /** Owner handles in declaration order, `@`/leading-sigil stripped. */
  owners: string[];
}

/**
 * Pure CODEOWNERS parse. Only PATH-SHAPED patterns survive: a glob
 * (`*.ts`, `src/**`) does not name a code anchor, and inventing one for
 * it would be exactly the guessing this indexer refuses to do.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/).filter(Boolean);
    const pattern = parts[0];
    if (pattern === undefined || parts.length < 2) return;
    if (/[*?[\]!]/.test(pattern)) return;
    const path = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) return;
    const owners = parts
      .slice(1)
      .map((o) => o.replace(/^@/, '').trim())
      .filter(Boolean);
    if (owners.length === 0) return;
    rules.push({ line: i + 1, raw: raw.trimEnd(), path, owners });
  });
  return rules;
}

/** CODEOWNERS-declared ownership, one fact per path-shaped rule. */
export function ownershipFromCodeowners(source: RepoSource): RepoFact[] {
  for (const file of CODEOWNERS_PATHS) {
    const text = source.readFile(file);
    if (text === null) continue;
    const rules = parseCodeowners(text);
    if (rules.length === 0) continue;
    return rules.map((rule) => {
      const owner = rule.owners[0] as string;
      const extra =
        rule.owners.length > 1
          ? ` The line declares ${rule.owners.length} owners; the first-listed owner is recorded (owns is single-valued).`
          : '';
      return {
        producer: 'core:ownership' as const,
        subject: rule.path,
        subjectType: 'asset' as const,
        kind: 'owns' as const,
        object: owner,
        derivation:
          `Declared in ${file} line ${rule.line}; the leading "@" is CODEOWNERS syntax and is not part of the handle.` +
          extra,
        evidence: {
          path: file,
          startLine: rule.line,
          endLine: rule.line,
          excerpt: rule.raw,
        },
        confidence: 0.9,
      };
    });
  }
  return [];
}

/** Per-path author tallies over a commit window. Pure. */
export function tallyAuthors(
  commits: CommitRecord[],
  depth: number,
): Map<string, Map<string, number>> {
  const byPath = new Map<string, Map<string, number>>();
  for (const commit of commits) {
    const author = commit.authorName;
    if (!author) continue;
    const seen = new Set<string>();
    for (const file of commit.changedFiles) {
      for (const dir of ancestorDirs(file, depth)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        const tally = byPath.get(dir) ?? new Map<string, number>();
        tally.set(author, (tally.get(author) ?? 0) + 1);
        byPath.set(dir, tally);
      }
    }
  }
  return byPath;
}

/** `src/a/b/c.ts` → `src`, `src/a` (depth 2). Files themselves are not anchors here. */
function ancestorDirs(file: string, depth: number): string[] {
  const parts = file.split('/').slice(0, -1);
  const dirs: string[] = [];
  for (let i = 1; i <= Math.min(depth, parts.length); i += 1) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

export interface HistoryOwnershipInput {
  commits: CommitRecord[];
  caps: IndexerCaps;
  headSha: string | null;
}

/**
 * Fallback ownership from authorship concentration. Emits a fact only
 * when the evidence clears BOTH thresholds, and the emitted excerpt is
 * the verbatim `sha author` tally the decision was made from — a reader
 * can re-derive the claim from it without trusting the indexer.
 */
export function ownershipFromHistory(input: HistoryOwnershipInput): RepoFact[] {
  const { commits, caps } = input;
  const byPath = tallyAuthors(commits, 2);
  const facts: RepoFact[] = [];
  for (const [path, tally] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = [...tally.values()].reduce((a, b) => a + b, 0);
    if (total < caps.ownershipMinCommits) continue;
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0];
    if (!top) continue;
    const [author, count] = top;
    const share = count / total;
    if (share < caps.ownershipMinShare) continue;
    facts.push({
      producer: 'core:ownership',
      subject: path,
      subjectType: 'asset',
      kind: 'owns',
      object: author,
      derivation:
        `No CODEOWNERS entry covers this path. Derived from git history: ${author} authored ` +
        `${count} of the ${total} commits touching ${path} in the last ${commits.length} commits ` +
        `(${Math.round(share * 100)}%), clearing the >=${caps.ownershipMinCommits}-commit and ` +
        `>=${Math.round(caps.ownershipMinShare * 100)}%-share thresholds. Authorship concentration ` +
        `is stewardship evidence, not a declaration of ownership.`,
      evidence: {
        path,
        startLine: 0,
        endLine: 0,
        excerpt: ranked.map(([a, c]) => `${c}\t${a}`).join('\n'),
        commit: input.headSha ?? undefined,
      },
      confidence: 0.55,
    });
  }
  return facts;
}
