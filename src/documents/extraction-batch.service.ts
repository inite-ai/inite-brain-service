import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { GENERAL_INDEXER_ID, GENERAL_INDEXER_VERSION } from '../indexers/candidate.types';
import { CandidateCommitService } from './candidate-commit.service';
import { CandidateStoreService } from './candidate-store.service';
import { DocumentStoreService, StoredDocument } from './document-store.service';
import { internalMetaString } from './document-meta';
import { planExtractionGroups } from './extraction-group';
import { MemoryContextService } from '../ingest/memory-context.service';
import { IndexerRunService, groupDocOf } from './indexer-run.service';

/**
 * Extraction off the write path. A document is remembered when it
 * arrives — stored, chunked, its raw turns captured — and answered from
 * raw until it is understood. Its generalist run waits `pending`; the
 * captures of one short window share ONE `extract_documents` job, which
 * reads every waiting document of the tenant in groups (one user scope,
 * one conversation, oldest first, a size budget — extraction-group.ts),
 * one extraction call per group on the offline tier, and commits the
 * documents in the order they were said.
 *
 * A failed group fails its runs; the pass then schedules a backed-off
 * retry pass (which also lists failed runs) — the document stays
 * remembered, raw, whatever the provider does.
 */
@Injectable()
export class ExtractionBatchService implements OnModuleInit {
  private readonly logger = new Logger(ExtractionBatchService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
    private readonly runs: IndexerRunService,
    private readonly commit: CandidateCommitService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly memory?: MemoryContextService,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register('extract_documents', (ctx) => this.handle(ctx), {
      ttlSeconds: 900,
      maxAttempts: 2,
    });
  }

  /** True when captured documents are read in the background (the default). */
  enabled(): boolean {
    return !!this.claim && backgroundExtractionEnabled();
  }

  /**
   * Ask for the window's batch pass. Every capture of one window asks for
   * the same job (the dedup key is the window), which reads whatever of
   * the tenant is waiting when it runs.
   */
  async schedule(companyId: string, p: { retry?: number; delayMs?: number } = {}): Promise<void> {
    if (!this.claim) return;
    const retry = p.retry ?? 0;
    const windowMs = p.delayMs ?? batchWindowMs();
    const bucket = Math.floor(Date.now() / Math.max(windowMs, 1000));
    await this.claim.enqueue({
      jobType: 'extract_documents',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `xdoc_${retry > 0 ? `r${retry}_` : ''}${bucket}`,
      payload: { retry },
      visibleAfter: new Date((bucket + 1) * Math.max(windowMs, 1000)),
    });
  }

  private async handle(ctx: JobContext): Promise<Record<string, unknown>> {
    return this.runPass(ctx.companyId, {
      retry: Number(ctx.payload?.retry ?? 0) || 0,
      abortSignal: ctx.abortSignal,
    });
  }

  /**
   * One pass: read everything of the tenant that is waiting, group by
   * group, until nothing is left or the pass budget is spent. The job
   * handler; also callable directly (an operator drain, a spec).
   */
  async runPass(
    companyId: string,
    opts: { retry?: number; abortSignal?: AbortSignal | undefined } = {},
  ): Promise<{ read: number; failed: number; committed: number; retry: number }> {
    const retry = opts.retry ?? 0;
    const ctx = { companyId, abortSignal: opts.abortSignal };
    const deadline = Date.now() + PASS_BUDGET_MS;
    let read = 0;
    let failed = 0;
    let committed = 0;
    // A document is read at most once per pass: a failed one waits for
    // the retry pass instead of being listed again by the next page.
    const attempted = new Set<string>();
    for (;;) {
      if (ctx.abortSignal?.aborted || Date.now() > deadline) {
        // Out of lease budget with work left: a fresh pass continues.
        await this.schedule(ctx.companyId, { delayMs: 1000 });
        break;
      }
      const docIds = (
        await this.candidates.listAwaitingRuns(ctx.companyId, {
          packId: GENERAL_INDEXER_ID,
          packVersion: GENERAL_INDEXER_VERSION,
          includeFailed: retry > 0,
          limit: PASS_DOCS + attempted.size,
        })
      )
        .filter((id) => !attempted.has(id))
        .slice(0, PASS_DOCS);
      if (docIds.length === 0) break;
      for (const id of docIds) attempted.add(id);
      const outcome = await this.readDocuments(ctx, docIds);
      read += outcome.read;
      failed += outcome.failed;
      committed += outcome.committed;
    }
    if (failed > 0 && retry < MAX_RETRIES) {
      await this.schedule(ctx.companyId, {
        retry: retry + 1,
        delayMs: RETRY_BASE_MS * 2 ** retry,
      });
    }
    if (read + failed > 0) {
      this.logger.log(
        `extract_documents ${ctx.companyId}: read=${read} failed=${failed} committed=${committed} retry=${retry}`,
      );
    }
    return { read, failed, committed, retry };
  }

  /** Read one page of waiting documents group by group, then commit them in order. */
  private async readDocuments(
    ctx: { companyId: string; abortSignal?: AbortSignal | undefined },
    docIds: string[],
  ): Promise<{ read: number; failed: number; committed: number }> {
    const docs: StoredDocument[] = [];
    const texts = new Map<string, string>();
    for (const id of docIds) {
      const doc = await this.store.getById(ctx.companyId, id);
      if (!doc) continue;
      const chunks = await this.store.getChunks(ctx.companyId, id);
      docs.push(doc);
      texts.set(id, chunks.map((c) => c.text).join('\n'));
    }
    const byId = new Map(docs.map((d) => [d.id, d]));
    const groups = planExtractionGroups(
      docs.map((d) => ({
        ...groupDocOf(d, texts.get(d.id) ?? ''),
        // A re-read aimed at one question reads its turn alone.
        ...(internalMetaString(d.meta, 'focusQuestion')
          ? { chunkCount: Number.MAX_SAFE_INTEGER }
          : {}),
      })),
      groupBudget(),
    );
    let read = 0;
    let failed = 0;
    const done: StoredDocument[] = [];
    for (const group of groups) {
      const members = group.map((g) => byId.get(g.id) as StoredDocument);
      try {
        if (members.length === 1) {
          const doc = members[0] as StoredDocument;
          const chunks = await this.store.getChunks(ctx.companyId, doc.id);
          await this.runs.runGeneral({
            companyId: ctx.companyId,
            doc,
            chunks,
            background: true,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          });
        } else {
          await this.runs.runGeneralGroup({
            companyId: ctx.companyId,
            docs: members,
            texts,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          });
        }
        read += members.length;
        done.push(...members);
      } catch (err) {
        failed += members.length;
        this.logger.warn(
          `extract_documents ${ctx.companyId}: a group of ${members.length} failed: ${(err as Error).message}`,
        );
      }
    }
    let committed = 0;
    for (const doc of done.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
      const result = await this.commit.commitIfRunsSettled(ctx.companyId, doc);
      if (!result.deferred && !result.committed) {
        // Read, and nothing in it to remember beyond its raw text.
        await this.store
          .setStatus({ companyId: ctx.companyId, docId: doc.id, status: 'indexed' })
          .catch(() => undefined);
      }
      if (result.committed) {
        committed += 1;
        // What the conversation is about, for the extraction of its next
        // turns (the mention path's memory, kept by whoever commits).
        this.memory?.remember(
          ctx.companyId,
          internalMetaString(doc.meta, 'conversationId'),
          result.entityIds,
        );
        await this.store
          .setStatus({ companyId: ctx.companyId, docId: doc.id, status: 'committed' })
          .catch(() => undefined);
      }
    }
    return { read, failed, committed };
  }
}

/** EXTRACTION_BACKGROUND: captured documents are read by the queue (default on). */
export function backgroundExtractionEnabled(): boolean {
  const raw = process.env.EXTRACTION_BACKGROUND;
  return raw === undefined || raw.trim() === '' ? true : envFlagEnabled(raw);
}

/** EXTRACTION_BATCH_WINDOW_SECONDS: how long captures gather before one pass reads them. */
function batchWindowMs(): number {
  const n = Number(process.env.EXTRACTION_BATCH_WINDOW_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 20_000;
}

/** EXTRACTION_GROUP_MAX_CHARS / EXTRACTION_GROUP_MAX_DOCS: what one extraction call reads. */
function groupBudget(): { maxChars: number; maxDocs: number } {
  const chars = Number(process.env.EXTRACTION_GROUP_MAX_CHARS);
  const count = Number(process.env.EXTRACTION_GROUP_MAX_DOCS);
  return {
    maxChars: Number.isFinite(chars) && chars > 0 ? chars : 12_000,
    maxDocs: Number.isFinite(count) && count > 0 ? count : 16,
  };
}

/** Documents one page of a pass lists. */
const PASS_DOCS = 64;
/** A pass stops taking pages after this (the job lease is 15 minutes). */
const PASS_BUDGET_MS = 10 * 60_000;
/** Retry passes after a pass with failed groups, and the first backoff. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 5 * 60_000;
