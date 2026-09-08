/**
 * `code_memory__gotcha` / `code_memory__invariant` — the warnings a
 * codebase writes to its future self.
 *
 * Source: COMMENTS ONLY, and only comments that explicitly warn. A
 * comment saying "must", "never", "always", "gotcha", "beware", "⚡"
 * is a human stating a rule or a trap; a comment describing what the
 * next line does is not, and is skipped. The recorded value is the
 * sentence verbatim, and the fact carries the file plus the 1-based line
 * span it was read from, so a reader can open the file and check.
 *
 * Language-agnostic: comment syntax is a small table (line-comment
 * prefixes plus C-style blocks), not ecosystem knowledge — an unknown
 * extension is simply not scanned.
 */
import type { RepoSource } from '../repo-source';
import type { IndexerCaps, RepoFact } from '../types';
import { SCANNED_EXTENSIONS } from '../types';

/** Line-comment prefix per extension family. */
const LINE_PREFIX: Record<string, string> = {
  '.ts': '//',
  '.tsx': '//',
  '.js': '//',
  '.jsx': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.go': '//',
  '.rs': '//',
  '.java': '//',
  '.kt': '//',
  '.py': '#',
  '.rb': '#',
  '.sh': '#',
  '.sql': '--',
};

/** Extensions that also carry C-style block comments. */
const BLOCK_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.sql',
]);

export interface CommentBlock {
  /** Verbatim comment text with markers stripped, newline-joined. */
  text: string;
  /** 1-based inclusive span in the source file. */
  startLine: number;
  endLine: number;
}

/** Pure: contiguous comment blocks of a source file. */
export function extractComments(text: string, ext: string): CommentBlock[] {
  const prefix = LINE_PREFIX[ext];
  if (!prefix) return [];
  const allowBlocks = BLOCK_EXTENSIONS.has(ext);
  const lines = text.split('\n');
  const blocks: CommentBlock[] = [];
  let open: { parts: string[]; start: number; end: number } | null = null;
  let inBlock = false;

  const flush = (): void => {
    if (open && open.parts.some((p) => p.trim())) {
      blocks.push({
        text: open.parts.join('\n').trim(),
        startLine: open.start,
        endLine: open.end,
      });
    }
    open = null;
  };
  const push = (content: string, lineNo: number): void => {
    if (open) {
      open.parts.push(content);
      open.end = lineNo;
    } else {
      open = { parts: [content], start: lineNo, end: lineNo };
    }
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (inBlock) {
      const close = trimmed.indexOf('*/');
      const body = (close === -1 ? trimmed : trimmed.slice(0, close)).replace(/^\*+\s?/, '');
      push(body, lineNo);
      if (close !== -1) {
        inBlock = false;
        flush();
      }
      return;
    }
    if (allowBlocks && trimmed.startsWith('/*')) {
      const close = trimmed.indexOf('*/', 2);
      const body = (close === -1 ? trimmed.slice(2) : trimmed.slice(2, close)).replace(
        /^\*+\s?/,
        '',
      );
      push(body, lineNo);
      if (close === -1) inBlock = true;
      else flush();
      return;
    }
    if (trimmed.startsWith(prefix)) {
      push(trimmed.slice(prefix.length).trim(), lineNo);
      return;
    }
    flush();
  });
  if (inBlock) flush();
  else flush();
  return blocks;
}

/**
 * Explicit trap language — a human FLAGGING a counter-intuitive
 * behaviour. The marker has to be used as a flag, not merely mentioned:
 * "caveat: reindex rewrites facts only" is a gotcha, while "decisions,
 * rationale, invariants, gotchas — anchored to code" is a sentence that
 * happens to contain the word. So a nominal marker counts only at the
 * start of a clause or when it introduces the warning with a colon or
 * dash; `beware` / `watch out` / `⚡` are imperative on their own.
 */
const GOTCHA_RE =
  /(?:^|[—:;-]\s*)(?:gotcha|caveat|pitfall|caution|warning)\b|\b(?:gotcha|caveat|pitfall|caution|warning)\s*[:—-]|\b(?:beware|watch out)\b|⚡/i;
/** Explicit rule language — a constraint the code must satisfy. */
const INVARIANT_RE = /\b(must not|must|never|always|invariant)\b/i;
/** Tooling noise that matches the markers but states nothing about the code. */
const NOISE_RE =
  /(eslint-disable|@ts-(?:ignore|expect-error|nocheck)|prettier-ignore|SPDX|Copyright)/i;

const MIN_SENTENCE_CHARS = 20;
const MAX_SENTENCE_CHARS = 400;

/** Pure: warning sentences of one comment block, tagged by kind. */
export function warningSentences(
  block: CommentBlock,
): Array<{ kind: 'gotcha' | 'invariant'; sentence: string }> {
  const flat = block.text.replace(/\s+/g, ' ').trim();
  const out: Array<{ kind: 'gotcha' | 'invariant'; sentence: string }> = [];
  for (const raw of flat.split(/(?<=[.!?;])\s+/)) {
    const sentence = raw.trim();
    if (sentence.length < MIN_SENTENCE_CHARS || sentence.length > MAX_SENTENCE_CHARS) continue;
    if (NOISE_RE.test(sentence)) continue;
    // Gotcha markers win: an explicit "beware" is a trap report even when
    // the same sentence also says "never".
    if (GOTCHA_RE.test(sentence)) out.push({ kind: 'gotcha', sentence });
    else if (INVARIANT_RE.test(sentence)) out.push({ kind: 'invariant', sentence });
  }
  return out;
}

export interface WarningInput {
  source: RepoSource;
  paths: string[];
  caps: IndexerCaps;
}

/** Gotchas and invariants across the scanned working-tree files. */
export function warningsFromComments(input: WarningInput): RepoFact[] {
  const facts: RepoFact[] = [];
  for (const path of input.paths) {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot);
    if (!SCANNED_EXTENSIONS.has(ext)) continue;
    const text = input.source.readFile(path);
    if (text === null) continue;
    let perFile = 0;
    for (const block of extractComments(text, ext)) {
      for (const { kind, sentence } of warningSentences(block)) {
        if (perFile >= input.caps.maxWarningsPerFile) break;
        perFile += 1;
        facts.push({
          producer: 'core:warnings',
          subject: path,
          subjectType: 'asset',
          kind,
          object: sentence,
          derivation:
            `Quoted verbatim from the comment at ${path} lines ${block.startLine}-${block.endLine}. ` +
            `Admitted as a ${kind} because the sentence carries explicit ` +
            `${kind === 'gotcha' ? 'trap' : 'rule'} language; descriptive comments are not read.`,
          evidence: {
            path,
            startLine: block.startLine,
            endLine: block.endLine,
            excerpt: block.text,
          },
          confidence: kind === 'gotcha' ? 0.75 : 0.7,
        });
        if (facts.length >= input.caps.maxCandidates) return facts;
      }
    }
  }
  return facts;
}
