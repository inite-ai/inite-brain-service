/**
 * Code-memory Phase 1 — VCS capture pipeline types.
 * (docs/roadmap/code-memory-domain.md)
 *
 * Hybrid client-side capture: this pipeline runs where the code lives (CI /
 * git hook / agent), extracting the engineering "why" from commit + PR text and
 * sending ONLY the resulting decision facts (+ file anchors + provenance) to the
 * brain server — raw source never leaves the machine. The sink is the existing
 * /v1/ingest/fact HTTP path (same IngestService.ingestFact as `record_decision`).
 *
 * Layered extraction:
 *   Layer 1 — cheap deterministic gate ({@link DecisionClassifier}). The
 *     interface a trained BiLSTM (CoMRAT-style) would implement; shipped now as
 *     a heuristic so there's no dependency on a labeled commit corpus.
 *   Layer 2 — LLM extraction ({@link DecisionExtractor}) of the
 *     Decision/Rationale taxonomy, only for commits Layer 1 admits.
 */

/** One commit's non-code signal — message, PR body, paths. NO file contents:
 *  Phase 1 anchors at file granularity; symbol-level is Phase 2 (SCIP). */
export interface CommitInput {
  sha: string;
  /** Full commit message (subject + body). */
  message: string;
  /** Linked PR / MR body, when resolvable. */
  prBody?: string;
  /** Paths touched by the commit (anchors), e.g. ["src/x.ts"]. */
  changedFiles: string[];
  /** Commit author date (ISO) — becomes the fact validFrom (event time). */
  authorDate: string;
}

/** Deterministic signals parsed from a commit message. */
export interface Layer1Signals {
  /** Conventional-commit type (feat/fix/refactor/chore/…) or null. */
  conventionalType: string | null;
  /** Git trailers (Key: value lines in the body), keyed lowercase. */
  trailers: Record<string, string>;
  /** Issue / PR references (#123). */
  issueRefs: string[];
  /** Body length in chars (subject excluded). */
  bodyLength: number;
  /** Rationale connective phrases found ("because", "instead of", …). */
  rationaleMarkers: string[];
}

/** Layer-1 gate verdict. */
export interface Layer1Verdict {
  likelyDecision: boolean;
  reason: string;
  signals: Layer1Signals;
}

export type DecisionKind = 'decided' | 'because' | 'invariant' | 'gotcha';

/** A single extracted decision, ready to become a code-memory fact. */
export interface DecisionCandidate {
  kind: DecisionKind;
  text: string;
  /** File anchor — "src/x.ts". Mapped to externalRef code:<path> by the sink. */
  anchor: string;
  /** Commit SHA provenance. */
  commit: string;
  /** Optional file:line provenance. */
  location?: string;
  validFrom: string;
  confidence?: number;
}

/** Layer 1 — cheap admit/reject gate. Swap the heuristic impl for a trained
 *  classifier without touching the pipeline. */
export interface DecisionClassifier {
  classify(commit: CommitInput): Layer1Verdict;
}

/** Layer 2 — LLM extraction of decision candidates from an admitted commit. */
export interface DecisionExtractor {
  extract(commit: CommitInput): Promise<DecisionCandidate[]>;
}

/** Terminal sink — records one candidate into brain (HTTP /v1/ingest/fact). */
export interface DecisionSink {
  record(candidate: DecisionCandidate): Promise<{ outcome: string }>;
}

export interface CaptureSummary {
  scanned: number;
  trivialSkipped: number;
  classifierRejected: number;
  extracted: number;
  recorded: number;
  failures: number;
}
