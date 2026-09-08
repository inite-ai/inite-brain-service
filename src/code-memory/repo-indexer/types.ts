/**
 * Reference code-repository indexer for the `code_memory` domain pack —
 * shared shapes and caps.
 *
 * The pack has declared `indexer: { mode: 'external' }` since 0.4.0 but
 * nothing ever fed it: the submission protocol, the work API and the
 * candidate ledger all existed with no producer on the code side. This
 * module is that producer. It walks a git working tree plus its history
 * and derives ONLY facts that trace back to a concrete artefact — a
 * CODEOWNERS line, a package.json entry, a config-catalogue row, a
 * commit message that states a decision, a comment that states a
 * warning. Nothing here summarizes code; a claim with no verbatim
 * artefact behind it is not emitted at all.
 *
 * Every derived fact carries its `derivation` — one sentence naming the
 * mechanical rule that produced it — which is written into the evidence
 * document alongside the quoted artefact. Brain therefore stores the
 * REASON the indexer believed something, not a bare assertion.
 */

/** The code_memory local predicate kinds this indexer can emit. */
export type RepoFactKind =
  'owns' | 'depends_on_version' | 'default_value' | 'decided' | 'because' | 'invariant' | 'gotcha';

/** Where a fact was read from — a repo-relative path and a line span. */
export interface RepoEvidence {
  /** Repo-relative path of the artefact (POSIX separators). */
  path: string;
  /** 1-based inclusive line span of `excerpt` inside `path`. */
  startLine: number;
  endLine: number;
  /** The artefact text, copied verbatim — never paraphrased. */
  excerpt: string;
  /** Commit the evidence was read at, when the source is git history. */
  commit?: string | undefined;
}

/**
 * Who derived a fact. `core:<section>` for the language-agnostic core,
 * `module:<id>@<version>` for an ecosystem module. It rides into the
 * evidence document and into every fact's derivation sentence, so a
 * module version bump is visible in exactly what it produced — the
 * server-side CandidateProvenance is a fixed shape (indexerId,
 * packVersion, executionMode, model) and cannot carry it.
 */
export type FactProducer = `core:${string}` | `module:${string}`;

/** One derived, artefact-traceable claim about the repository. */
export interface RepoFact {
  /** {@link FactProducer} — set by the deriver, never by the caller. */
  producer: FactProducer;
  /**
   * The code anchor (path), flag identifier, or dependency name that owns
   * the claim. Always a verbatim repo token — never a prose subject.
   */
  subject: string;
  /** Entity type hint passed through to the candidate batch. */
  subjectType: 'asset' | 'concept';
  kind: RepoFactKind;
  /** The claim value, verbatim from the artefact. */
  object: string;
  /** The mechanical rule that produced this fact, as one sentence. */
  derivation: string;
  evidence: RepoEvidence;
  confidence: number;
}

/** A fact plus its deterministic identity (the idempotency key). */
export interface IdentifiedRepoFact extends RepoFact {
  /** sha256(path | kind | contentHash) — stable across runs and clones. */
  candidateId: string;
}

/** A fact the client refused to send, and why. */
export interface DroppedRepoFact {
  candidateId: string;
  kind: RepoFactKind;
  subject: string;
  reason:
    | 'namespace_fence'
    | 'not_value_shaped'
    | 'name_too_long'
    | 'object_too_long'
    | 'empty_span'
    | 'ungrounded_entity'
    | 'ungrounded_value'
    | 'already_submitted'
    | 'single_active_collision'
    | 'over_run_cap';
  detail: string;
}

/**
 * Bounds on one run. Every one is a hard stop, not a hint: an indexer
 * pointed at an unexpected tree (a monorepo, a vendored checkout) must
 * degrade into "indexed the first N" rather than into an unbounded walk
 * or a submission flood.
 */
export interface IndexerCaps {
  /** Working-tree files opened for scanning. */
  maxFiles: number;
  /** Files larger than this are skipped whole (minified/generated). */
  maxFileBytes: number;
  /** Commits read from history. */
  maxCommits: number;
  /** Facts emitted per run, across every deriver. */
  maxCandidates: number;
  /** Facts packed into one evidence document (server cap is 200/kind). */
  maxFactsPerDocument: number;
  /** Evidence-document text budget (server hard cap is 512_000). */
  maxDocChars: number;
  /** Warning-comment facts taken from a single file. */
  maxWarningsPerFile: number;
  /** Commits inspected when attributing a path to its dominant author. */
  ownershipHistoryDepth: number;
  /** Minimum commits touching a path before authorship is asserted. */
  ownershipMinCommits: number;
  /** Minimum share of those commits the dominant author must hold. */
  ownershipMinShare: number;
}

export const DEFAULT_CAPS: IndexerCaps = {
  maxFiles: 5_000,
  maxFileBytes: 512_000,
  maxCommits: 500,
  maxCandidates: 500,
  maxFactsPerDocument: 120,
  maxDocChars: 100_000,
  maxWarningsPerFile: 5,
  ownershipHistoryDepth: 200,
  ownershipMinCommits: 3,
  ownershipMinShare: 0.5,
};

/** Server-side submission caps (src/documents/external-candidates.service.ts). */
export const MAX_ENTITY_NAME_CHARS = 256;
export const MAX_FACT_OBJECT_CHARS = 2_000;

/**
 * Trees never walked. Build output, dependency stores and vendored code
 * are not this repository's engineering "why" — they are someone else's,
 * and indexing them would mint ownership and gotcha claims about code the
 * tenant does not author.
 */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor',
  'third_party',
  'thirdparty',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  'models',
]);

/** Extensions whose comments are scanned for warnings. */
export const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.rs',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.sql',
  '.sh',
]);

/** Extensions read as prose for ADR-style decisions. */
export const PROSE_EXTENSIONS = new Set(['.md', '.mdx']);
