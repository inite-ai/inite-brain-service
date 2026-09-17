import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { evidenceDocumentBridgeEnabled } from '../common/evidence-flags';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, type JobContext } from '../jobs/worker-loop.service';
import {
  EvidenceDocumentBridgeService,
  evidenceBridgeDedupKey,
  type EvidenceBridgeRef,
} from './evidence-document-bridge.service';

/**
 * The jobs plumbing of the evidence → document bridge
 * (EVIDENCE_DOCUMENT_BRIDGE) — the seed-ingest mold: onModuleInit
 * register + queue handler + an enqueue for documents-side callers. The
 * broker enqueues on its own (it cannot import this module) through the
 * same dedupKey helper, so both ends of the seam agree on the key.
 * Split from the runner so each constructor stays ≤3 (the
 * compaction / calibration-refit precedent).
 */
@Injectable()
export class EvidenceDocumentBridgeQueueService implements OnModuleInit {
  constructor(
    private readonly runner: EvidenceDocumentBridgeService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'evidence_document_bridge',
      (ctx) => this.executeFromQueue(ctx),
      // Synchronous ingest per part (LLM extraction per chunk), a few
      // parts at most — the seed-ingest budget.
      { ttlSeconds: 600, maxAttempts: 3 },
    );
  }

  /** Enqueue the bridge for one representation; dedup per (asset, representation). */
  async enqueue(companyId: string, p: EvidenceBridgeRef): Promise<{ enqueued: boolean }> {
    if (!this.claim || !evidenceDocumentBridgeEnabled()) return { enqueued: false };
    const { created } = await this.claim.enqueue({
      jobType: 'evidence_document_bridge',
      companyId,
      triggeredBy: 'manual',
      dedupKey: evidenceBridgeDedupKey(p.assetId, p.representationId),
      payload: { ...p },
    });
    return { enqueued: created };
  }

  private async executeFromQueue(ctx: JobContext): Promise<Record<string, unknown>> {
    const assetId = String(ctx.payload?.assetId ?? '');
    const representationId = String(ctx.payload?.representationId ?? '');
    const packId = String(ctx.payload?.packId ?? '');
    if (!assetId || !representationId || !packId) return { skipped: 'missing_payload' };
    const result = await this.runner.bridge(
      ctx.companyId,
      { assetId, representationId, packId },
      ctx.abortSignal,
    );
    return { ...result };
  }
}
