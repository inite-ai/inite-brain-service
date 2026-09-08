/**
 * `code_memory__decided` / `code_memory__because` — the engineering
 * "why", read ONLY where a human wrote it down.
 *
 * Two sources, both language-agnostic:
 *
 *   COMMIT MESSAGES. A message that explicitly states a decision
 *     ("decided to …", "chose X over Y") is quoted verbatim. The anchor
 *     is a path the message itself names, or — failing that — the
 *     commit's single changed file. A commit that touched twelve files
 *     and names no path has no anchor, so it produces NOTHING: guessing
 *     which of the twelve the decision was about is exactly the
 *     invention this indexer refuses.
 *   ADR-STYLE DOCS. A markdown file with a `## Decision` section states
 *     a decision about itself; the document IS the artefact, so it is
 *     its own anchor. `## Rationale` / `## Context` / `## Why` sections
 *     become the rationale.
 *
 * Code SHAPE is never a source. A decision that nobody wrote down is
 * not a decision this indexer knows about.
 */
import type { CommitRecord, RepoSource } from '../repo-source';
import type { IndexerCaps, RepoFact } from '../types';
import { PROSE_EXTENSIONS } from '../types';

/** Explicit decision language. Deliberately narrow — no "should", no "use". */
const DECISION_RE =
  /\b(?:we\s+)?(?:decided|decision|chose|chosen|opted|settled\s+on|agreed\s+to)\b/i;
/** Explicit rationale language. */
const RATIONALE_RE = /\b(?:because|rationale|reason(?:ing)?:|the\s+reason\s+is|so\s+that)\b/i;
/** A repo-relative path spelled inside prose. */
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,7}\b/;
/** A directory path spelled inside prose (`src/fovea`, `docs/roadmap`). */
const DIR_RE = /\b(?:src|test|scripts|docs|packs|clients|examples)\/[\w.-]+(?:\/[\w.-]+)*\b/;

const MIN_STATEMENT_CHARS = 20;
const MAX_STATEMENT_CHARS = 400;

/** Split a message into trimmed, non-empty sentence-ish units. */
function statements(message: string): string[] {
  return message
    .split(/\n{2,}|(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_STATEMENT_CHARS && s.length <= MAX_STATEMENT_CHARS);
}

/**
 * The anchor rule, stated so it can be quoted into the fact: a path the
 * message names, else the commit's ONLY changed file, else nothing.
 */
export function anchorForCommit(
  commit: CommitRecord,
  statement: string,
): {
  anchor: string;
  rule: string;
} | null {
  const named = PATH_RE.exec(statement)?.[0] ?? DIR_RE.exec(statement)?.[0];
  if (named) {
    return { anchor: named, rule: `the commit message names the anchor "${named}"` };
  }
  const only = commit.changedFiles.length === 1 ? commit.changedFiles[0] : undefined;
  if (only) {
    return {
      anchor: only,
      rule: `the commit changed exactly one file, so that file is the anchor`,
    };
  }
  return null;
}

export interface CommitDecisionInput {
  commits: CommitRecord[];
  caps: IndexerCaps;
}

/** Decisions and rationale stated in commit messages. */
export function decisionsFromCommits(input: CommitDecisionInput): RepoFact[] {
  const facts: RepoFact[] = [];
  for (const commit of input.commits) {
    for (const statement of statements(commit.message)) {
      const isDecision = DECISION_RE.test(statement);
      const isRationale = RATIONALE_RE.test(statement);
      if (!isDecision && !isRationale) continue;
      const anchored = anchorForCommit(commit, statement);
      if (!anchored) continue;
      const short = commit.sha.slice(0, 12);
      facts.push({
        producer: 'core:decisions',
        subject: anchored.anchor,
        subjectType: 'asset',
        kind: isDecision ? 'decided' : 'because',
        object: statement,
        derivation:
          `Quoted verbatim from commit ${short} (${commit.date}) by ${commit.authorName}; ` +
          `${anchored.rule}. Admitted because the message states a ` +
          `${isDecision ? 'decision' : 'rationale'} in explicit language — code shape is never a source.`,
        evidence: {
          path: anchored.anchor,
          startLine: 0,
          endLine: 0,
          excerpt: statement,
          commit: commit.sha,
        },
        confidence: isDecision ? 0.8 : 0.75,
      });
      if (facts.length >= input.caps.maxCandidates) return facts;
    }
  }
  return facts;
}

interface Section {
  heading: string;
  startLine: number;
  endLine: number;
  body: string;
}

/** Pure: markdown ATX sections with their 1-based line spans. */
export function parseSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let current: { heading: string; start: number; body: string[] } | null = null;
  const flush = (endLine: number): void => {
    if (!current) return;
    sections.push({
      heading: current.heading,
      startLine: current.start,
      endLine,
      body: current.body.join('\n').trim(),
    });
    current = null;
  };
  lines.forEach((line, i) => {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      flush(i);
      current = { heading: m[1], start: i + 1, body: [] };
      return;
    }
    current?.body.push(line);
  });
  flush(lines.length);
  return sections;
}

const DECISION_HEADING = /^(decision|the decision|what we decided)$/i;
const RATIONALE_HEADING = /^(rationale|context|why|motivation|reasoning)$/i;

/** First paragraph of a section, collapsed to one line and length-capped. */
function firstParagraph(body: string): string | null {
  const para = body
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length >= MIN_STATEMENT_CHARS);
  if (!para) return null;
  return para.length > MAX_STATEMENT_CHARS ? null : para;
}

/** Decisions stated in ADR-style markdown under the scanned prose files. */
export function decisionsFromDocs(source: RepoSource, paths: string[]): RepoFact[] {
  const facts: RepoFact[] = [];
  for (const path of paths) {
    const dot = path.lastIndexOf('.');
    if (dot === -1 || !PROSE_EXTENSIONS.has(path.slice(dot))) continue;
    const text = source.readFile(path);
    if (text === null) continue;
    for (const section of parseSections(text)) {
      const isDecision = DECISION_HEADING.test(section.heading);
      const isRationale = RATIONALE_HEADING.test(section.heading);
      if (!isDecision && !isRationale) continue;
      const statement = firstParagraph(section.body);
      if (!statement) continue;
      facts.push({
        producer: 'core:decisions',
        subject: path,
        subjectType: 'asset',
        kind: isDecision ? 'decided' : 'because',
        object: statement,
        derivation:
          `First paragraph of the "${section.heading}" section of ${path} ` +
          `(lines ${section.startLine}-${section.endLine}), quoted verbatim. ` +
          `An ADR-style document states a decision about itself, so the document is its own anchor.`,
        evidence: {
          path,
          startLine: section.startLine,
          endLine: section.endLine,
          excerpt: statement,
        },
        confidence: isDecision ? 0.85 : 0.8,
      });
    }
  }
  return facts;
}
