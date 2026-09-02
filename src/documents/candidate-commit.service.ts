import { Injectable, Optional } from '@nestjs/common';
import { KeyedMutex } from '../common/keyed-mutex';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { MetricsService } from '../metrics/metrics.service';
import { traceArtifact, traceSpan } from '../common/debug-trace';
import { CandidateStoreService } from './candidate-store.service';
import {
  CommitWriterService,
  FactWriteOutcome,
  RelationWriteOutcome,
} from './commit-writer.service';
import type { StoredDocument } from './document-store.service';
import { mergeCandidates, MergedFact, MergeResult } from './candidate-merge';
import { SceneCandidateWriterService } from './scene-candidate-writer.service';
import { packMemoryProjectionsEnabled } from '../common/pack-projection-flags';
import type { CandidateKind } from '../indexers/candidate.types';

export interface CommitResult {
  committed: boolean;
  entityIds: string[];
  factIds: string[];
  edgeIds: string[];
  counts: {
    pending: number;
    committed: number;
    merged: number;
    rejected: number;
  };
}

interface StatusUpdate {
  id: string;
  kind: CandidateKind;
  status: 'committed' | 'merged' | 'rejected';
  statusReason?: string | undefined;
  commitRef?: string | undefined;
}

/**
 * CommitMemory — the Brain step. Takes a document's PENDING candidates
 * (possibly from several indexers), merges duplicates across indexers and
 * chunks (candidate-merge, pure), batch-embeds, and drives the merged
 * facts through the EXISTING conflict engine (fn::resolve_fact via
 * CommitWriterService). "Already known? conflict? source trusted? worth
 * remembering?" are the resolver's decisions — this service does not
 * build a second decision engine; it prepares the resolver's input and
 * records what happened back onto the candidate rows.
 *
 * Serialized per (company, document): concurrent commits of one document
 * would double-resolve the same candidates.
 */
@Injectable()
export class CandidateCommitService {
  private readonly commitLock = new KeyedMutex();

  // CommitMemory is the Brain-step orchestrator (staging reads, embedding
  // batch, graph writes, status accounting, metrics) — the dreams-service
  // mold; a further split would only add pass-through classes.
  // eslint-disable-next-line max-params
  constructor(
    private readonly candidates: CandidateStoreService,
    private readonly writer: CommitWriterService,
    private readonly factEmbedding: FactEmbeddingService,
    // 0110 episodic-plane projection; @Optional so direct unit
    // constructions of the semantic path need no stub.
    @Optional() private readonly sceneWriter?: SceneCandidateWriterService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async commitDocument(companyId: string, doc: StoredDocument): Promise<CommitResult> {
    const lockKey = `commit\x00${companyId}\x00${doc.id}`;
    return this.commitLock.run(lockKey, () =>
      traceSpan('brain.commit', () => this.commitLocked(companyId, doc)),
    );
  }

  /**
   * Async-queue variant: commit ONLY when every indexer run for the
   * document is terminal. Each finishing index job enqueues one of these;
   * all but the last defer — the last commits everything at once so the
   * cross-indexer merge sees the full candidate set.
   */
  async commitIfRunsSettled(
    companyId: string,
    doc: StoredDocument,
  ): Promise<CommitResult & { deferred: boolean }> {
    const open = await this.candidates.countNonTerminalRuns(companyId, doc.id);
    if (open > 0) {
      this.metrics?.countCommitMemory('noop');
      return { ...emptyResult(), deferred: true };
    }
    const result = await this.commitDocument(companyId, doc);
    return { ...result, deferred: false };
  }

  private async commitLocked(companyId: string, doc: StoredDocument): Promise<CommitResult> {
    const pending = await this.candidates.loadPending(companyId, doc.id);
    if (pending.length === 0) {
      this.metrics?.countCommitMemory('noop');
      return emptyResult();
    }

    const merge = mergeCandidates(pending);
    const minConfidence = envFloat('CANDIDATE_MIN_CONFIDENCE', 0);
    const factsToWrite = merge.facts.filter((f) => f.confidence >= minConfidence);
    const lowConfidence = merge.facts.filter((f) => f.confidence < minConfidence);
    traceArtifact('brain.commit.merge', {
      docId: doc.id,
      pending: pending.length,
      entities: merge.entities.length,
      facts: merge.facts.length,
      relations: merge.relations.length,
      rejected: merge.rejected.length,
      lowConfidence: lowConfidence.length,
    });

    const embeddings = await this.embedBatch(factsToWrite);
    const written = await this.writer.writeMerged({
      companyId,
      doc,
      merge,
      factsToWrite,
      embeddings,
    });

    const updates = this.buildStatusUpdates({ merge, lowConfidence, written });
    await this.candidates.markStatuses(companyId, updates);
    for (const u of updates) {
      this.metrics?.countCandidate(u.kind, u.status);
    }
    this.metrics?.countCommitMemory('ok');

    // 0110 episodic-plane projection, AFTER the semantic path settled and
    // inside the same per-(company, doc) lock: pending scene/state_delta
    // candidates (the mergers above skip them by kind) become shadow
    // memory_episode rows. Flag-gated at the call site so the flag-off
    // commit is byte-identical; the writer marks its own candidate
    // statuses and swallows its own failures (a projection error must not
    // fail a semantic commit that already landed). CommitResult counts
    // stay semantic-plane-only either way — the wire contract is
    // unchanged.
    if (packMemoryProjectionsEnabled() && this.sceneWriter) {
      const projectionRows = pending.filter((c) => c.kind === 'scene' || c.kind === 'state_delta');
      if (projectionRows.length > 0) {
        await this.sceneWriter.projectDocument(companyId, doc, projectionRows);
      }
    }

    return {
      committed: true,
      entityIds: [...written.entityIds.values()],
      factIds: written.facts.flatMap((f) => (f.factId ? [f.factId] : [])),
      edgeIds: written.relations.flatMap((r) => (r.edgeId ? [r.edgeId] : [])),
      counts: {
        pending: pending.length,
        committed: updates.filter((u) => u.status === 'committed').length,
        merged: updates.filter((u) => u.status === 'merged').length,
        rejected: updates.filter((u) => u.status === 'rejected').length,
      },
    };
  }

  private async embedBatch(facts: MergedFact[]): Promise<number[][]> {
    if (!facts.length) return [];
    try {
      return await this.factEmbedding.embedMany(facts.map((f) => `${f.predicate}: ${f.object}`));
    } catch {
      // Same trade as the mention path: pay per-fact embed round-trips in
      // the resolver rather than fail the whole commit on an embedder
      // hiccup.
      return [];
    }
  }

  private buildStatusUpdates(p: {
    merge: MergeResult;
    lowConfidence: MergedFact[];
    written: Awaited<ReturnType<CommitWriterService['writeMerged']>>;
  }): StatusUpdate[] {
    return [
      ...p.merge.rejected.map((r): StatusUpdate => ({
        id: r.candidateId,
        kind: r.kind,
        status: 'rejected',
        statusReason: r.reason,
      })),
      ...p.lowConfidence.flatMap((f) =>
        f.contributors.map((c): StatusUpdate => ({
          id: c.candidateId,
          kind: 'fact',
          status: 'rejected',
          statusReason: 'low_confidence',
        })),
      ),
      ...entityUpdates(p.merge, p.written.entityIds),
      ...p.written.facts.flatMap(factUpdates),
      ...p.written.relations.flatMap(relationUpdates),
    ];
  }
}

function entityUpdates(merge: MergeResult, entityIds: Map<string, string>): StatusUpdate[] {
  return merge.entities.flatMap((me) => {
    const entityId = entityIds.get(me.key);
    const [leader, ...rest] = me.candidateIds;
    if (leader === undefined) return []; // no candidate ids → nothing to update
    const leaderUpdate: StatusUpdate = {
      id: leader,
      kind: 'entity',
      status: entityId ? 'committed' : 'rejected',
      statusReason: entityId ? undefined : 'entity_resolve_failed',
      commitRef: entityId,
    };
    const dupUpdates = rest.map((dup): StatusUpdate => ({
      id: dup,
      kind: 'entity',
      status: 'merged',
      statusReason: `merged_into:${leader}`,
      commitRef: entityId,
    }));
    return [leaderUpdate, ...dupUpdates];
  });
}

function factUpdates(fo: FactWriteOutcome): StatusUpdate[] {
  const ok = fo.factId !== null && fo.outcome !== 'REJECTED';
  const leaderUpdate: StatusUpdate = {
    id: fo.fact.leaderId,
    kind: 'fact',
    status: ok ? 'committed' : 'rejected',
    statusReason: ok ? (fo.outcome ?? undefined) : 'resolver_rejected',
    commitRef: fo.factId ?? undefined,
  };
  const dupUpdates = fo.fact.mergedIds.map((dup): StatusUpdate => ({
    id: dup,
    kind: 'fact',
    status: ok ? 'merged' : 'rejected',
    statusReason: ok ? `merged_into:${fo.fact.leaderId}` : 'resolver_rejected',
    commitRef: fo.factId ?? undefined,
  }));
  return [leaderUpdate, ...dupUpdates];
}

function relationUpdates(ro: RelationWriteOutcome): StatusUpdate[] {
  const ok = ro.edgeId !== null;
  const leaderUpdate: StatusUpdate = {
    id: ro.relation.leaderId,
    kind: 'relation',
    status: ok ? 'committed' : 'rejected',
    statusReason: ok ? undefined : 'edge_write_failed',
    commitRef: ro.edgeId ?? undefined,
  };
  const dupUpdates = ro.relation.mergedIds.map((dup): StatusUpdate => ({
    id: dup,
    kind: 'relation',
    status: ok ? 'merged' : 'rejected',
    statusReason: ok ? `merged_into:${ro.relation.leaderId}` : 'edge_write_failed',
    commitRef: ro.edgeId ?? undefined,
  }));
  return [leaderUpdate, ...dupUpdates];
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function emptyResult(): CommitResult {
  return {
    committed: false,
    entityIds: [],
    factIds: [],
    edgeIds: [],
    counts: { pending: 0, committed: 0, merged: 0, rejected: 0 },
  };
}
