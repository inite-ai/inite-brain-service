/**
 * The runner: core derivers + registered ecosystem modules → fences →
 * evidence documents → submission, with the state file that makes a
 * re-run over an unchanged repository a no-op.
 *
 * IDEMPOTENCY has two independent layers. Client-side, the state file
 * remembers every candidate id already submitted, so a second run drops
 * them before composing anything. Server-side, the evidence document is
 * a deterministic function of the facts, so it dedupes by contentHash
 * and the `indexer_run` UNIQUE ledger answers 409 for a slot already
 * processed — which the runner reports, never treats as an error.
 *
 * INCREMENTAL runs pass `--since <commit>`: history is read as
 * `since..HEAD` and the working-tree scan is narrowed to the paths that
 * commit range touched. When the delta cannot be computed (no git, an
 * unknown ref) the runner falls back to a full walk and says so, rather
 * than silently indexing nothing.
 */
import { assignPaths, type EcosystemModule } from './modules/module.types';
import { ownershipFromCodeowners, ownershipFromHistory } from './core/ownership';
import { decisionsFromCommits, decisionsFromDocs } from './core/decisions';
import { warningsFromComments } from './core/warnings';
import {
  applyGroundingFence,
  applyShapeFences,
  composeEvidenceDocuments,
  identify,
  toCandidatePayload,
} from './bundle';
import type { BrainClient } from './brain-client';
import type { RepoSource } from './repo-source';
import type { DroppedRepoFact, IdentifiedRepoFact, IndexerCaps, RepoFact } from './types';

export interface RunState {
  /** HEAD of the last successful run — the default `--since`. */
  lastCommit: string | null;
  lastRunAt: string | null;
  /** Every candidate id ever submitted from this repository. */
  submitted: string[];
}

export const EMPTY_STATE: RunState = { lastCommit: null, lastRunAt: null, submitted: [] };

export interface RunOptions {
  source: RepoSource;
  client: BrainClient;
  caps: IndexerCaps;
  packId: string;
  repoLabel: string;
  modules: readonly EcosystemModule[];
  state: RunState;
  /** Exclusive lower-bound commit-ish; undefined = full walk. */
  since?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface RunSummary {
  headSha: string | null;
  incremental: boolean;
  filesScanned: number;
  commitsRead: number;
  derived: number;
  submitted: number;
  dropped: DroppedRepoFact[];
  documents: number;
  alreadyProcessed: number;
  /** Producer → fact count, for the operator's run report. */
  byProducer: Record<string, number>;
  nextState: RunState;
}

/** Derive everything: the language-agnostic core, then the modules. */
export function derive(p: {
  source: RepoSource;
  paths: string[];
  modules: readonly EcosystemModule[];
  caps: IndexerCaps;
  headSha: string | null;
  commits: ReturnType<RepoSource['readCommits']>;
}): RepoFact[] {
  const facts: RepoFact[] = [];

  // ── Core (always runs, knows no language) ─────────────────────────
  const declared = ownershipFromCodeowners(p.source);
  facts.push(
    ...(declared.length > 0
      ? declared
      : ownershipFromHistory({ commits: p.commits, caps: p.caps, headSha: p.headSha })),
  );
  facts.push(...decisionsFromCommits({ commits: p.commits, caps: p.caps }));
  facts.push(...decisionsFromDocs(p.source, p.paths));
  facts.push(...warningsFromComments({ source: p.source, paths: p.paths, caps: p.caps }));

  // ── Ecosystem modules (each on the paths it won) ──────────────────
  const assigned = assignPaths(p.modules, p.paths);
  for (const mod of p.modules) {
    const owned = assigned.get(mod.id);
    if (!owned || owned.length === 0) continue;
    facts.push(...mod.extract({ paths: owned, source: p.source, caps: p.caps }));
  }
  return facts;
}

export async function runIndexer(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((): void => {});
  const headSha = opts.source.head();
  const commits = opts.source.readCommits({
    since: opts.since,
    limit: opts.since ? opts.caps.maxCommits : opts.caps.ownershipHistoryDepth,
  });

  const allPaths = opts.source.listFiles().map((f) => f.path);
  let paths = allPaths;
  let incremental = false;
  if (opts.since) {
    const changed = opts.source.changedSince(opts.since);
    if (changed === null) {
      log(`since=${opts.since} could not be resolved — falling back to a full walk`);
    } else {
      const changedSet = new Set(changed);
      paths = allPaths.filter((p) => changedSet.has(p));
      incremental = true;
      log(`incremental: ${paths.length} of ${allPaths.length} files changed since ${opts.since}`);
    }
  }

  const derived = derive({
    source: opts.source,
    paths,
    modules: opts.modules,
    caps: opts.caps,
    headSha,
    commits,
  });
  const identified = identify(derived);
  const byProducer: Record<string, number> = {};
  for (const fact of identified) {
    byProducer[fact.producer] = (byProducer[fact.producer] ?? 0) + 1;
  }

  const shape = applyShapeFences({
    facts: identified,
    packId: opts.packId,
    caps: opts.caps,
    alreadySubmitted: new Set(opts.state.submitted),
  });
  const dropped: DroppedRepoFact[] = [...shape.dropped];

  const documents = composeEvidenceDocuments({
    facts: shape.kept,
    packId: opts.packId,
    caps: opts.caps,
    repoLabel: opts.repoLabel,
    headSha,
  });

  const submittedIds: string[] = [];
  let alreadyProcessed = 0;
  let documentCount = 0;
  const occurredAt = new Date().toISOString();
  for (const [i, doc] of documents.entries()) {
    const grounded = applyGroundingFence(doc);
    dropped.push(...grounded.dropped);
    if (grounded.kept.length === 0) continue;
    const ingested = await opts.client.ingestDocument({
      text: doc.text,
      title: `${opts.repoLabel} repository evidence ${i + 1}/${documents.length}`,
      originUri: `repo://${opts.repoLabel}${headSha ? `@${headSha}` : ''}#${i + 1}`,
      occurredAt,
    });
    const outcome = await opts.client.submitCandidates(
      ingested.documentId,
      toCandidatePayload(grounded.kept, opts.packId),
    );
    documentCount += 1;
    if (outcome.alreadyProcessed) {
      alreadyProcessed += 1;
      log(`document ${ingested.documentId} was already processed for this pack version`);
    } else if (outcome.dropped.length > 0) {
      log(`server dropped ${outcome.dropped.length} item(s) from ${ingested.documentId}`);
    }
    // Recorded either way: an already-processed slot means these exact
    // candidates are staged, so re-offering them next run is pure noise.
    submittedIds.push(...grounded.kept.map((f: IdentifiedRepoFact) => f.candidateId));
  }

  return {
    headSha,
    incremental,
    filesScanned: paths.length,
    commitsRead: commits.length,
    derived: identified.length,
    submitted: submittedIds.length,
    dropped,
    documents: documentCount,
    alreadyProcessed,
    byProducer,
    nextState: {
      lastCommit: headSha ?? opts.state.lastCommit,
      lastRunAt: occurredAt,
      submitted: [...new Set([...opts.state.submitted, ...submittedIds])],
    },
  };
}
