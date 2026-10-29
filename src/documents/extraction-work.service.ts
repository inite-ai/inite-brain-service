import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { runInCircle } from '../auth/circle-scope';
import { pinUserScope } from '../auth/user-scope';
import { ExtractorService } from '../ai/extractor.service';
import type { MemoryContext } from '../ai/extractor-internals/memory-context';
import { GENERAL_INDEXER_ID, GENERAL_INDEXER_VERSION } from '../indexers/candidate.types';
import { CandidateStoreService, staleRunMs } from './candidate-store.service';
import { DocumentStoreService, type StoredDocument } from './document-store.service';
import { internalMetaString } from './document-meta';
import {
  ExtractionBatchService,
  PASS_DOCS,
  groupBudget,
  settleRule,
} from './extraction-batch.service';
import { planExtractionGroups, releaseSettled, type GroupDoc } from './extraction-group';
import { workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type ExtractionTokenPayload } from '../common/harness-work-token';
import { IndexerRunService, groupDocOf, type ClaimedRun } from './indexer-run.service';
import { askOf } from './read-depth';

/** One group handed to the connected agent (take_memory_work, kind extraction). */
export type ExtractionWork = HarnessWork & { kind: 'extraction' };

/** What a submission did (submit_memory_work, kind extraction). */
export interface ExtractionSubmitOutcome {
  documents: number;
  facts: number;
  entities: number;
  edges: number;
  committed: number;
}

/**
 * Harness mode (#819, EXTRACTION_SOURCE=harness): the connected agent reads
 * captured documents with its own model. `take` claims the oldest waiting
 * group exactly as the background pass would pick it, and returns the
 * prompt our extractor would send for it at one sample — built by the same
 * code (ExtractorService.prepareRead), not a copy. `submit` re-renders the
 * same text server-side, runs the agent's JSON through the server's own
 * post-processing (grounding, entity grounding, edges, refinement,
 * denoise — the model-backed extraction check excepted), stages it on the
 * claimed runs and commits in order, like the pass.
 *
 * An abandoned claim: the runs stay `running` until the run ledger's stale
 * window (INDEXER_RUN_STALE_MINUTES, default 30) passes; the candidate
 * sweeper's reapStaleRuns then marks them `failed`, and `take` lists failed
 * runs (createRun reopens them), so the documents are taken again. The
 * token expires a minute BEFORE that window, so a late submit can never
 * land on runs someone else has re-claimed.
 *
 * The prompt names memory by position ([e#], [m#]); the token carries the
 * record id behind every handle it showed, so submit maps the reply's
 * handles without rebuilding the memory context — whose entity set rides
 * an in-process per-conversation cache and whose order moves with every
 * write. Any replica, any time inside the window, reads the same handles.
 */
@Injectable()
export class ExtractionWorkService {
  private readonly logger = new Logger(ExtractionWorkService.name);
  /** Submissions in flight in this process, by nonce (a double submit). */
  private readonly inFlight = new Set<string>();

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
    private readonly runs: IndexerRunService,
    private readonly extractor: ExtractorService,
    private readonly batch: ExtractionBatchService,
  ) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; maxDocs?: number | undefined } = {},
  ): Promise<ExtractionWork | null> {
    const userId = pinUserScope(opts.userId);
    const groups = await this.waitingGroups(companyId, userId);
    const maxDocs = Math.max(1, Math.min(opts.maxDocs ?? Number.POSITIVE_INFINITY, PASS_DOCS));
    for (const { group, docs, texts } of groups) {
      const members = group.slice(0, maxDocs).map((g) => docs.get(g.id) as StoredDocument);
      const { claimed } = await this.runs.claimGroup(companyId, members);
      if (claimed.length === 0) continue;
      const circleKey = group[0]?.circleKey ?? '';
      try {
        const work = await runInCircle(circlesOf(circleKey), () =>
          this.prepare(companyId, { claimed, texts, userId, circleKey }),
        );
        if (work) return work;
      } catch (err) {
        await this.runs.failRuns(companyId, runIdsOf(claimed), err);
        throw err;
      }
    }
    return null;
  }

  /** Apply a verified extraction token's reply (the MCP layer checks the signature and scope). */
  async submit(
    companyId: string,
    payload: ExtractionTokenPayload,
    result: unknown,
  ): Promise<ExtractionSubmitOutcome> {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new BadRequestException('result must be the JSON object the schema describes');
    }
    if (this.inFlight.has(payload.n)) throw new ConflictException('this work is being submitted');
    this.inFlight.add(payload.n);
    try {
      return await runInCircle(circlesOf(payload.k), () => this.apply(companyId, payload, result));
    } finally {
      this.inFlight.delete(payload.n);
    }
  }

  /** The waiting groups of one user scope, in the order the pass reads them. */
  private async waitingGroups(
    companyId: string,
    userId: string | undefined,
  ): Promise<
    Array<{ group: GroupDoc[]; docs: Map<string, StoredDocument>; texts: Map<string, string> }>
  > {
    // Failed runs too: the pass lists them on its retry passes, which
    // harness mode never schedules — and a reaped abandoned claim is one.
    const waiting = await this.candidates.listAwaitingRuns(companyId, {
      packId: GENERAL_INDEXER_ID,
      packVersion: GENERAL_INDEXER_VERSION,
      includeFailed: true,
      limit: PASS_DOCS,
    });
    const docs = new Map<string, StoredDocument>();
    const texts = new Map<string, string>();
    const candidates: GroupDoc[] = [];
    for (const w of waiting) {
      const doc = await this.store.getById(companyId, w.docId);
      // One scope per credential: a tenant-global caller never reads a
      // user's turns, and a user reads only their own.
      if (!doc || (doc.userId ?? undefined) !== userId) continue;
      const text = (await this.store.getChunks(companyId, doc.id)).map((c) => c.text).join('\n');
      docs.set(doc.id, doc);
      texts.set(doc.id, text);
      candidates.push({
        ...groupDocOf(doc, text),
        arrivedAt: w.arrivedAt,
        urgent: askOf(w.priority) !== undefined || !!internalMetaString(doc.meta, 'focusQuestion'),
        solo: !!internalMetaString(doc.meta, 'focusQuestion'),
      });
    }
    const budget = groupBudget();
    const { ready } = releaseSettled(candidates, new Date(), {
      ...settleRule(),
      maxChars: budget.maxChars,
    });
    const first = (g: GroupDoc[]) => g[0]?.occurredAt.getTime() ?? 0;
    const urgent = (g: GroupDoc[]) => (g.some((d) => d.urgent) ? 1 : 0);
    return planExtractionGroups(ready, budget)
      .sort((a, b) => urgent(b) - urgent(a) || first(a) - first(b))
      .map((group) => ({ group, docs, texts }));
  }

  /** Build the prompt of a claimed group and sign its token (inside its circle). */
  private async prepare(
    companyId: string,
    p: {
      claimed: ClaimedRun[];
      texts: Map<string, string>;
      userId: string | undefined;
      circleKey: string;
    },
  ): Promise<ExtractionWork | null> {
    const { rendered, context } = await this.runs.groupInput(companyId, p.claimed, p.texts);
    const read = await this.extractor.prepareRead({ text: rendered.text, companyId, context });
    if (!read) {
      await this.runs.failRuns(companyId, runIdsOf(p.claimed), new Error('empty_text'));
      return null;
    }
    const exp = Math.floor((Date.now() + tokenTtlMs()) / 1000);
    const nonce = workNonce();
    const payload: ExtractionTokenPayload = {
      v: 2,
      t: 'extraction',
      c: companyId,
      ...(p.userId !== undefined ? { u: p.userId } : {}),
      d: p.claimed.map(({ doc }) => doc.id),
      r: runIdsOf(p.claimed),
      h: read.vocabularyHash,
      k: p.circleKey,
      x: {
        e: (context.memory?.entities ?? []).map((e) => e.id),
        m: (context.memory?.facts ?? []).map((f) => f.id),
      },
      n: nonce,
      exp,
    };
    this.logger.log(`harness work taken ${companyId}: documents=${p.claimed.length}`);
    return {
      kind: 'extraction',
      token: mintWorkToken(payload),
      systemPrompt: read.systemPrompt,
      userContent: read.userContent,
      schema: read.schema,
      items: p.claimed.length,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  private async apply(
    companyId: string,
    payload: ExtractionTokenPayload,
    result: object,
  ): Promise<ExtractionSubmitOutcome> {
    const claimed = await this.claimedRuns(companyId, payload);
    const runIds = runIdsOf(claimed);
    const vocabulary = (await this.extractor.vocabularyVersionHash(companyId)) ?? 'fallback-seed';
    if (vocabulary !== payload.h) {
      await this.runs.failRuns(companyId, runIds, new Error('vocabulary_changed'));
      throw new ConflictException('the predicate vocabulary changed; take the work again');
    }
    const texts = new Map<string, string>();
    for (const { doc } of claimed) {
      const chunks = await this.store.getChunks(companyId, doc.id);
      texts.set(doc.id, chunks.map((c) => c.text).join('\n'));
    }
    const input = await this.runs.groupInput(companyId, claimed, texts);
    const context = { ...input.context, memory: handlesOf(input.context.memory, payload.x) };
    const startedAt = Date.now();
    const finalized = new Set<string>();
    try {
      const extraction = await this.extractor.assembleRead({
        text: input.rendered.text,
        companyId,
        context,
        rawJson: result,
      });
      await this.runs.stageGroup({
        companyId,
        claimed,
        read: {
          groupDocs: input.groupDocs,
          extraction,
          model: 'harness',
          startedAt,
          depth: 'single',
        },
        finalized,
      });
      const committed = await this.batch.commitInOrder(
        companyId,
        claimed.map(({ doc }) => doc),
      );
      this.logger.log(
        `harness work submitted ${companyId}: documents=${claimed.length} facts=${extraction.facts.length} committed=${committed}`,
      );
      return {
        documents: claimed.length,
        facts: extraction.facts.length,
        entities: extraction.entities.length,
        edges: extraction.edges.length,
        committed,
      };
    } catch (err) {
      await this.runs.failRuns(
        companyId,
        runIds.filter((r) => !finalized.has(r)),
        err,
      );
      throw err;
    }
  }

  /**
   * The token's runs, still claimed and still on its documents. A run that
   * is no longer `running` was submitted already (a replay) or reclaimed.
   */
  private async claimedRuns(
    companyId: string,
    payload: ExtractionTokenPayload,
  ): Promise<ClaimedRun[]> {
    const claimed: ClaimedRun[] = [];
    for (const [i, docId] of payload.d.entries()) {
      const runId = payload.r[i] as string;
      const run = await this.candidates.getRun(companyId, runId);
      if (!run || run.status !== 'running' || run.docId !== docId) {
        throw new ConflictException('this work was already submitted or released');
      }
      const doc = await this.store.getById(companyId, docId);
      if (!doc) throw new ConflictException('a document of this work no longer exists');
      claimed.push({ doc, runId });
    }
    return claimed;
  }
}

function runIdsOf(claimed: ClaimedRun[]): string[] {
  return claimed.map(({ runId }) => runId);
}

function circlesOf(circleKey: string): string[] {
  return circleKey.split(',').filter(Boolean);
}

/** A minute inside the run ledger's stale window (see the class comment). */
export function tokenTtlMs(): number {
  return Math.max(60_000, staleRunMs() - 60_000);
}

/**
 * The memory the reply's handles resolve against: the rebuilt context
 * (date, turns, vocabulary) with exactly the entities and facts the
 * prompt showed, by the ids the token carries. Only handle and id are
 * read when a reply is assembled (knownEntityId / supersededFactIds).
 */
function handlesOf(
  rebuilt: MemoryContext | undefined,
  x: ExtractionTokenPayload['x'],
): MemoryContext {
  return {
    ...(rebuilt ?? { recentTurns: [], predicates: [] }),
    entities: x.e.map((id, i) => ({ handle: `e${i + 1}`, id, name: '', type: '' })),
    facts: x.m.map((id, i) => ({
      handle: `m${i + 1}`,
      id,
      entityHandle: '',
      predicate: '',
      object: '',
    })),
  };
}
