import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService, JobContext } from '../jobs/worker-loop.service';
import { GENERAL_INDEXER_ID, GENERAL_INDEXER_VERSION } from '../indexers/candidate.types';
import { CandidateCommitService } from './candidate-commit.service';
import { CandidateStoreService } from './candidate-store.service';
import { DocumentStoreService, StoredDocument } from './document-store.service';
import type { DocumentChunk } from './chunker';
import { internalMetaString } from './document-meta';
import {
  planExtractionGroups,
  releaseSettled,
  renderGroup,
  type GroupDoc,
} from './extraction-group';
import { MemoryContextService } from '../ingest/memory-context.service';
import { DecisionService } from '../ai/decisions/decision.service';
import { triageText, type TriageStamp } from './triage';
import { isUrgent, readDepth, triageFloor, type ReadDepth } from './read-depth';
import { ExtractionMetrics } from './extraction.metrics';
import { LeaderLeaseService } from '../jobs/leader-lease.service';
import { Semaphore } from '../common/semaphore';
import { retryOnReadConflict } from '../db/surreal-retry';
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
 * Not everything is read, and not all of it alike (read-depth.ts): every
 * waiting text is first triaged (D1, one cheap decision request); a
 * correction, a change, an instruction or a self-identification — or a
 * text an answer had to cite, or one beside such a text — is read at once
 * and in full, ahead of the rest; routine text is read with one sample;
 * noise is kept raw until something asks for it (CandidateStoreService.
 * promote).
 *
 * A failed group fails its runs; the pass then schedules a backed-off
 * retry pass (which also lists failed runs) — the document stays
 * remembered, raw, whatever the provider does.
 */
@Injectable()
export class ExtractionBatchService implements OnModuleInit {
  private readonly logger = new Logger(ExtractionBatchService.name);
  /** The pass each tenant is running in this process (exclusive()). */
  private readonly running = new Map<string, Promise<void>>();

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
    private readonly runs: IndexerRunService,
    private readonly commit: CandidateCommitService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly memory?: MemoryContextService,
    @Optional() private readonly decisions?: DecisionService,
    @Optional() private readonly metrics?: ExtractionMetrics,
    @Optional() private readonly lease?: LeaderLeaseService,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register('extract_documents', (ctx) => this.handle(ctx), {
      ttlSeconds: 900,
      maxAttempts: 2,
    });
  }

  /** Captured documents are read by the queue — wherever there is one to read them. */
  enabled(): boolean {
    return !!this.claim;
  }

  /**
   * Ask for the window's batch pass. Every capture of one window asks for
   * the same job (the dedup key is the window), which reads whatever of
   * the tenant is waiting when it runs.
   */
  async schedule(companyId: string, p: { retry?: number; delayMs?: number } = {}): Promise<void> {
    if (!this.claim) return;
    const retry = p.retry ?? 0;
    // The pass runs at the first window boundary at least `delayMs` from
    // now; every request aiming at the same boundary is one job (the key).
    const window = Math.max(batchWindowMs(), 1000);
    const at = Math.ceil((Date.now() + (p.delayMs ?? 0)) / window) * window;
    await this.claim.enqueue({
      jobType: 'extract_documents',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `xdoc_${retry > 0 ? `r${retry}_` : ''}${at}`,
      payload: { retry },
      visibleAfter: new Date(at),
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
    opts: {
      retry?: number;
      abortSignal?: AbortSignal | undefined;
      /** Read every waiting conversation now, quiet or not (an operator drain). */
      force?: boolean;
    } = {},
  ): Promise<{ read: number; failed: number; committed: number; retry: number }> {
    return this.exclusive(companyId, opts.force === true, () => this.pass(companyId, opts));
  }

  /**
   * One pass at a time per tenant — in this process (a drain waits for the
   * scheduled pass and then reads what is left) and across replicas (a
   * lease renewed before every group). Two passes over one scope would
   * read its documents out of order: each would miss what the other
   * commits. A scheduled pass that finds another replica holding the
   * tenant steps back and asks again later; a drain waits for it.
   */
  private async exclusive<T extends { retry: number }>(
    companyId: string,
    wait: boolean,
    body: () => Promise<T & { read: number; failed: number; committed: number }>,
  ): Promise<T & { read: number; failed: number; committed: number }> {
    const previous = this.running.get(companyId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => mine);
    this.running.set(companyId, chained);
    await previous;
    const name = `extract_documents:${companyId}`;
    try {
      const deadline = Date.now() + LEASE_WAIT_MS;
      while (this.lease && !(await this.lease.tryAcquire(name, LEASE_TTL_SECONDS))) {
        if (!wait || Date.now() > deadline) {
          await this.schedule(companyId, { delayMs: LEASE_TTL_SECONDS * 1000 });
          return { read: 0, failed: 0, committed: 0, retry: 0 } as T & {
            read: number;
            failed: number;
            committed: number;
          };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      return await body();
    } finally {
      await this.lease?.release(name).catch(() => undefined);
      release();
      if (this.running.get(companyId) === chained) this.running.delete(companyId);
    }
  }

  private async pass(
    companyId: string,
    opts: { retry?: number; abortSignal?: AbortSignal | undefined; force?: boolean },
  ): Promise<{ read: number; failed: number; committed: number; retry: number }> {
    const retry = opts.retry ?? 0;
    // A drain reads until nothing is left; a scheduled pass stops within
    // its job lease and a fresh pass continues.
    const deadline = opts.force ? Number.POSITIVE_INFINITY : Date.now() + PASS_BUDGET_MS;
    const name = `extract_documents:${companyId}`;
    const ctx = {
      companyId,
      abortSignal: opts.abortSignal,
      deadline,
      renew: async () => {
        await this.lease?.tryAcquire(name, LEASE_TTL_SECONDS);
      },
    };
    let read = 0;
    let failed = 0;
    let committed = 0;
    // A document is read at most once per pass: a failed one waits for
    // the retry pass instead of being listed again by the next page.
    const attempted = new Set<string>();
    let nextAt: Date | undefined;
    for (;;) {
      if (ctx.abortSignal?.aborted || Date.now() > deadline) {
        // Out of lease budget with work left: a fresh pass continues.
        await this.schedule(ctx.companyId, { delayMs: 1000 });
        break;
      }
      const waiting = (
        await this.candidates.listAwaitingRuns(ctx.companyId, {
          packId: GENERAL_INDEXER_ID,
          packVersion: GENERAL_INDEXER_VERSION,
          includeFailed: retry > 0,
          limit: PASS_DOCS + attempted.size,
        })
      )
        .filter((w) => !attempted.has(w.docId))
        .slice(0, PASS_DOCS);
      if (waiting.length === 0) break;
      for (const w of waiting) attempted.add(w.docId);
      const outcome = await this.readDocuments(ctx, waiting, opts.force === true);
      read += outcome.read;
      failed += outcome.failed;
      committed += outcome.committed;
      if (outcome.nextAt && (!nextAt || outcome.nextAt < nextAt)) nextAt = outcome.nextAt;
    }
    if (nextAt) {
      // A conversation still talking: read it when it goes quiet.
      await this.schedule(ctx.companyId, {
        delayMs: Math.max(1000, nextAt.getTime() - Date.now()),
      });
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

  /**
   * Read one page of waiting documents group by group, then commit them in
   * order. Conversations still talking are held (releaseSettled) unless
   * `force`; `nextAt` says when the first of them goes quiet.
   */
  private async readDocuments(
    ctx: PassContext,
    waiting: Array<{ docId: string; arrivedAt: Date; priority: number }>,
    force: boolean,
  ): Promise<{ read: number; failed: number; committed: number; nextAt?: Date }> {
    const arrived = new Map(waiting.map((w) => [w.docId, w.arrivedAt]));
    const priority = new Map(waiting.map((w) => [w.docId, w.priority]));
    // The page is loaded at once (bounded), in its listed order.
    const loader = new Semaphore(LOAD_CONCURRENCY);
    const loaded = await Promise.all(
      waiting.map(({ docId }) =>
        loader.run(async () => {
          const doc = await this.store.getById(ctx.companyId, docId);
          if (!doc) return null;
          return { doc, chunks: await this.store.getChunks(ctx.companyId, docId) };
        }),
      ),
    );
    const docs: StoredDocument[] = [];
    const texts = new Map<string, string>();
    const chunksOf = new Map<string, DocumentChunk[]>();
    for (const l of loaded) {
      if (!l) continue;
      docs.push(l.doc);
      chunksOf.set(l.doc.id, l.chunks);
      texts.set(l.doc.id, l.chunks.map((c) => c.text).join('\n'));
    }
    // D1: what the first cheap read makes of every text not yet triaged.
    const stamps = await this.triageWaiting(ctx.companyId, docs, texts);
    const floor = triageFloor();
    const byId = new Map(docs.map((d) => [d.id, d]));
    const candidates = docs.map((d) => ({
      ...groupDocOf(d, texts.get(d.id) ?? ''),
      arrivedAt: arrived.get(d.id),
      // Read now: something asked for it, or it changes what the memory
      // holds or how it answers.
      urgent: isPromoted(d, priority) || isUrgent([stamps.get(d.id)], floor),
      // A re-read aimed at one question reads its turn alone.
      ...(internalMetaString(d.meta, 'focusQuestion')
        ? { chunkCount: Number.MAX_SAFE_INTEGER }
        : {}),
    }));
    const budget = groupBudget();
    const { ready, nextAt } = force
      ? { ready: candidates, nextAt: undefined }
      : releaseSettled(candidates, new Date(), { ...settleRule(), maxChars: budget.maxChars });
    const groups = planExtractionGroups(ready, budget);
    // One memory scope reads in the order it was told, each group committed
    // before the next is read: the extractor reads a document against what
    // the memory already holds and supersedes it by handle (known facts),
    // so a later document read before an earlier one's facts are committed
    // cannot replace them. Scopes are independent and read concurrently.
    const byScope = new Map<string, GroupDoc[][]>();
    for (const group of groups) {
      const key = group[0]?.userId ?? '';
      byScope.set(key, [...(byScope.get(key) ?? []), group]);
    }
    const limiter = new Semaphore(passConcurrency());
    const outcomes = await Promise.all(
      [...byScope.values()].map((scoped) =>
        limiter.run(() =>
          this.readScope(ctx, scoped, { byId, texts, chunksOf, stamps, priority, floor }),
        ),
      ),
    );
    const sum = (k: 'read' | 'failed' | 'committed') => outcomes.reduce((n, o) => n + o[k], 0);
    return {
      read: sum('read'),
      failed: sum('failed'),
      committed: sum('committed'),
      ...(nextAt ? { nextAt } : {}),
    };
  }

  /** One scope's groups, oldest first: read, commit, then the next. */
  private async readScope(
    ctx: PassContext,
    groups: GroupDoc[][],
    page: Page,
  ): Promise<{ read: number; failed: number; committed: number }> {
    const out = { read: 0, failed: 0, committed: 0 };
    const first = (g: GroupDoc[]) => g[0]?.occurredAt.getTime() ?? 0;
    const asked = (g: GroupDoc[]) => Math.max(...g.map((d) => page.priority.get(d.id) ?? 0));
    // What something asked for first, then in the order it was said (a
    // text is read against what was said before it, so the order is not
    // what keeps a later value from being replaced by an earlier one).
    const ordered = [...groups].sort((a, b) => asked(b) - asked(a) || first(a) - first(b));
    for (const group of ordered) {
      // Past the budget the rest waits for the next pass (still pending),
      // so a pass never outlives its job lease by more than one group.
      if (ctx.abortSignal?.aborted || Date.now() > ctx.deadline) break;
      await ctx.renew();
      const depth = await this.depthOf(ctx.companyId, group, page);
      this.metrics?.depth(depth, group.length);
      if (depth === 'raw') {
        await this.keepRaw(ctx.companyId, group, page);
        continue;
      }
      await this.captureNeighbours(ctx.companyId, group);
      const r = await this.readGroup(ctx, { group, depth }, page);
      if (!r.ok) {
        out.failed += r.members.length;
        continue;
      }
      out.read += r.members.length;
      out.committed += await this.commitInOrder(ctx.companyId, r.members);
    }
    return out;
  }

  /** One group's read, at its depth. Never throws. */
  private async readGroup(
    ctx: PassContext,
    { group, depth }: { group: GroupDoc[]; depth: Exclude<ReadDepth, 'raw'> },
    page: Page,
  ): Promise<{ ok: boolean; members: StoredDocument[] }> {
    const members = group.map((g) => page.byId.get(g.id) as StoredDocument);
    const { texts } = page;
    try {
      if (members.length === 1) {
        const doc = members[0] as StoredDocument;
        const chunks = page.chunksOf.get(doc.id) ?? [];
        await this.runs.runGeneral({
          companyId: ctx.companyId,
          doc,
          chunks,
          background: true,
          depth,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });
      } else {
        await this.runs.runGeneralGroup({
          companyId: ctx.companyId,
          docs: members,
          texts,
          depth,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });
      }
      this.metrics?.read(
        members.length > 1 ? 'group' : 'solo',
        members.length,
        group.reduce((n, d) => n + d.text.length, 0),
      );
      return { ok: true, members };
    } catch (err) {
      this.logger.warn(
        `extract_documents ${ctx.companyId}: a group of ${members.length} failed: ${(err as Error).message}`,
      );
      return { ok: false, members };
    }
  }

  /**
   * Commit the read documents in the order they were said. Each commit is
   * its own: a write conflict (another pass committing the same tenant)
   * is retried, and a commit that still fails is left to the candidate
   * sweeper (its candidates stay pending) instead of failing the pass.
   */
  private async commitInOrder(companyId: string, done: StoredDocument[]): Promise<number> {
    let committed = 0;
    for (const doc of [...done].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
      try {
        const result = await retryOnReadConflict(() =>
          this.commit.commitIfRunsSettled(companyId, doc),
        );
        if (!result.deferred && !result.committed) {
          // Read, and nothing in it to remember beyond its raw text.
          await this.store
            .setStatus({ companyId, docId: doc.id, status: 'indexed' })
            .catch(() => undefined);
        }
        if (result.committed) {
          committed += 1;
          // What the conversation is about, for the extraction of its next
          // turns (the mention path's memory, kept by whoever commits).
          this.memory?.remember(
            companyId,
            internalMetaString(doc.meta, 'conversationId'),
            result.entityIds,
          );
          await this.store
            .setStatus({ companyId, docId: doc.id, status: 'committed' })
            .catch(() => undefined);
        }
      } catch (err) {
        this.logger.warn(
          `extract_documents ${companyId}: commit of ${doc.id} failed (left to the sweeper): ${(err as Error).message}`,
        );
      }
    }
    return committed;
  }

  /**
   * D1 for every waiting text not yet triaged (triage.ts), off the write
   * path: a standalone document on its own, a conversation as its unread
   * turns rendered together (a turn alone — "yes, let's" — says nothing;
   * the judge reads what the extractor will read). A conversation that
   * gained a turn is judged again as a whole. Returns the stamp of every
   * document that has one; a failed or disabled triage stamps nothing
   * (and nothing unstamped is ever left raw).
   */
  private async triageWaiting(
    companyId: string,
    docs: StoredDocument[],
    texts: Map<string, string>,
  ): Promise<Map<string, TriageStamp>> {
    const stamps = new Map<string, TriageStamp>();
    for (const d of docs) if (d.triage) stamps.set(d.id, d.triage);
    const units = new Map<string, StoredDocument[]>();
    for (const d of docs) {
      const conversationId = internalMetaString(d.meta, 'conversationId');
      const key = conversationId ? `${d.userId ?? ''}\x1e${conversationId}` : d.id;
      units.set(key, [...(units.get(key) ?? []), d]);
    }
    const stale = [...units.values()].filter((u) => u.some((d) => !stamps.has(d.id)));
    if (stale.length === 0 || !this.decisions?.enabled('triage')) return stamps;
    const limiter = new Semaphore(TRIAGE_CONCURRENCY);
    await Promise.all(
      stale.map((unit) =>
        limiter.run(async () => {
          try {
            const members = unit.map((d) => groupDocOf(d, texts.get(d.id) ?? ''));
            const text =
              members.length === 1 ? (members[0]?.text ?? '') : renderGroup(members).text;
            const stamp = await triageText(this.decisions, text);
            if (!stamp) return;
            await this.store.setTriage(
              companyId,
              unit.map((d) => d.id),
              stamp,
            );
            for (const d of unit) stamps.set(d.id, stamp);
          } catch (e) {
            this.logger.warn(`triage failed (${companyId}): ${(e as Error).message}`);
          }
        }),
      ),
    );
    return stamps;
  }

  /**
   * How deep one group is read (read-depth.ts): its triage, whether
   * something asked for it, and — only when that would leave it shallow —
   * whether it names an entity the memory is using now.
   */
  private async depthOf(companyId: string, group: GroupDoc[], page: Page): Promise<ReadDepth> {
    const members = group.map((g) => page.byId.get(g.id) as StoredDocument);
    const signals = {
      stamps: group.map((g) => page.stamps.get(g.id)),
      promoted: members.some((d) => isPromoted(d, page.priority)),
      hot: false,
      floor: page.floor,
    };
    const depth = readDepth(signals);
    if (depth === 'full' || !this.memory) return depth;
    const first = members[0] as StoredDocument;
    const hot = await this.memory.inUse({
      companyId,
      text: group.map((g) => g.text).join('\n\n'),
      userId: first.userId,
    });
    return hot ? readDepth({ ...signals, hot }) : depth;
  }

  /**
   * Keep a group raw (depth `raw`): its runs close as `skipped` with the
   * depth recorded, the documents stay remembered and served from their
   * raw turns, and any later need reopens them (CandidateStoreService.
   * promote). No extraction runs.
   */
  private async keepRaw(companyId: string, group: GroupDoc[], page: Page): Promise<void> {
    for (const g of group) {
      const doc = page.byId.get(g.id) as StoredDocument;
      try {
        await this.runs.keepRaw({ companyId, doc });
        await this.store.setStatus({ companyId, docId: doc.id, status: 'indexed' });
      } catch (e) {
        this.logger.warn(`keep-raw of ${doc.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Retroactive capture (§4.2 T-8): an urgent read — a correction, a
   * change, an instruction, or one something asked for — reopens the
   * turns of its conversation that were kept raw, so they are read now
   * with it in mind. Their priority puts them ahead of the backlog.
   */
  private async captureNeighbours(companyId: string, group: GroupDoc[]): Promise<void> {
    const urgent = group.some((g) => g.urgent);
    const conversationId = group[0]?.conversationId;
    if (!urgent || !conversationId) return;
    const reopened = await this.candidates
      .promote(companyId, {
        packId: GENERAL_INDEXER_ID,
        packVersion: GENERAL_INDEXER_VERSION,
        priority: PRIORITY_NEIGHBOUR,
        conversation: { conversationId, userId: group[0]?.userId },
      })
      .catch(() => 0);
    this.metrics?.promoted('neighbour', reopened);
    if (reopened > 0) await this.schedule(companyId, { delayMs: 1000 });
  }
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

/**
 * EXTRACTION_CONVERSATION_SETTLE_SECONDS / EXTRACTION_CONVERSATION_MAX_WAIT_SECONDS:
 * a conversation is read once quiet this long, and never later than the
 * wait bound after its oldest unread turn (defaults 120 s / 600 s).
 */
function settleRule(): { settleMs: number; maxWaitMs: number } {
  const settle = Number(process.env.EXTRACTION_CONVERSATION_SETTLE_SECONDS);
  const wait = Number(process.env.EXTRACTION_CONVERSATION_MAX_WAIT_SECONDS);
  return {
    settleMs: (Number.isFinite(settle) && settle >= 0 ? settle : 120) * 1000,
    maxWaitMs: (Number.isFinite(wait) && wait >= 0 ? wait : 600) * 1000,
  };
}

/** EXTRACTION_PASS_CONCURRENCY: memory scopes one pass reads at once (default 4). */
function passConcurrency(): number {
  const n = Number(process.env.EXTRACTION_PASS_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

/** One loaded page of waiting documents. */
interface Page {
  byId: Map<string, StoredDocument>;
  texts: Map<string, string>;
  chunksOf: Map<string, DocumentChunk[]>;
  /** D1 stamps, per document. */
  stamps: Map<string, TriageStamp>;
  /** The waiting run's priority (0168), per document. */
  priority: Map<string, number>;
  floor: number;
}

/**
 * Something asked for this read: an answer that cited it or a correction
 * beside it raised its priority (0168), or it is a re-read aimed at a
 * question.
 */
function isPromoted(doc: StoredDocument, priority: Map<string, number>): boolean {
  return (priority.get(doc.id) ?? 0) > 0 || !!internalMetaString(doc.meta, 'focusQuestion');
}

/** What one pass carries down to its reads. */
interface PassContext {
  companyId: string;
  abortSignal?: AbortSignal | undefined;
  /** Epoch ms after which no further group is started. */
  deadline: number;
  /** Renew the tenant's pass lease (before each group). */
  renew: () => Promise<void>;
}

/** The tenant's pass lease: renewed before every group, so a crashed holder frees it within this. */
const LEASE_TTL_SECONDS = 120;
/** How long a drain waits for another replica's pass to finish. */
const LEASE_WAIT_MS = 60 * 60_000;

/** Triage requests in flight at once. */
const TRIAGE_CONCURRENCY = 8;
/** Priority of a raw-kept turn reopened beside an urgent read (0168). */
const PRIORITY_NEIGHBOUR = 1;
/** Documents of a page loaded at once. */
const LOAD_CONCURRENCY = 8;
/** Documents one page of a pass lists. */
const PASS_DOCS = 64;
/** A pass stops taking pages after this (the job lease is 15 minutes). */
const PASS_BUDGET_MS = 10 * 60_000;
/** Retry passes after a pass with failed groups, and the first backoff. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 5 * 60_000;
