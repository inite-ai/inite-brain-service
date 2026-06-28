import type { CommitInput, Layer1Signals } from './types';

/**
 * Pure parsers over a commit message — the deterministic substrate Layer 1
 * classifies on. No LLM, no IO.
 */

const CONVENTIONAL_RE = /^([a-z]+)(?:\([^)]*\))?!?:/;
const ISSUE_RE = /#(\d+)/g;
// Rationale connectives that signal a "why" is present in prose.
const RATIONALE_MARKERS = [
  'because',
  'so that',
  'in order to',
  'instead of',
  'rather than',
  'to avoid',
  'to prevent',
  'otherwise',
  'the reason',
];
// Trailer keys that explicitly carry decision/rationale content.
export const DECISION_TRAILER_KEYS = [
  'decision',
  'why',
  'rationale',
  'breaking change',
  'breaking-change',
  'gotcha',
  'invariant',
];

function subjectAndBody(message: string): { subject: string; body: string } {
  const nl = message.indexOf('\n');
  if (nl === -1) return { subject: message.trim(), body: '' };
  return {
    subject: message.slice(0, nl).trim(),
    body: message.slice(nl + 1).trim(),
  };
}

function parseTrailers(body: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z][A-Za-z -]*):\s+(.+)$/.exec(line.trim());
    if (m) trailers[m[1].toLowerCase()] = m[2].trim();
  }
  return trailers;
}

export function parseCommitSignals(commit: CommitInput): Layer1Signals {
  const { subject, body } = subjectAndBody(commit.message);
  const ctMatch = CONVENTIONAL_RE.exec(subject);
  const haystack = `${body}\n${commit.prBody ?? ''}`.toLowerCase();
  const rationaleMarkers = RATIONALE_MARKERS.filter((m) => haystack.includes(m));
  const issueRefs = Array.from(
    `${subject}\n${haystack}`.matchAll(ISSUE_RE),
    (m) => m[1],
  );
  return {
    conventionalType: ctMatch ? ctMatch[1] : null,
    trailers: parseTrailers(body),
    issueRefs: Array.from(new Set(issueRefs)),
    bodyLength: body.length,
    rationaleMarkers,
  };
}

export function isMergeCommit(commit: CommitInput): boolean {
  return /^Merge (branch|pull request|remote-tracking) /.test(
    commit.message.trimStart(),
  );
}
