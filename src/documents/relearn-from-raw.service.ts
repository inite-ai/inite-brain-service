import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { JobClaimService } from '../jobs/job-claim.service';
import { WorkerLoopService } from '../jobs/worker-loop.service';
import { idTailOf } from '../ingest/ingest-utils';
import { CandidateCommitService } from './candidate-commit.service';
import { DocumentStoreService, type StoredDocument } from './document-store.service';
import { IndexerRunService } from './indexer-run.service';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { DocumentIngestService } from './document-ingest.service';
import { internalDocumentMeta, INTERNAL_DOCUMENT_META_MAX_CHARS } from './document-meta';
import { traceArtifact } from '../common/debug-trace';
import { CandidateStoreService } from './candidate-store.service';
import { ExtractionBatchService } from './extraction-batch.service';
import { ExtractionMetrics } from './extraction.metrics';
import { GENERAL_INDEXER_ID, GENERAL_INDEXER_VERSION } from '../indexers/candidate.types';

export interface RelearnRequest {
  companyId: string;
  userId?: string | undefined;
  /** The raw turns the answer was read from (L3 episode citations). */
  episodeIds: string[];
  question: string;
  answer: string;
  /**
   * The answer also cited facts: the memory carried it, so a turn whose
   * document was already read has nothing to teach — only an unread or
   * raw-kept one is promoted. Absent = the answer rested on raw text.
   */
  factCited?: boolean | undefined;
}

interface EpisodeRow {
  id: unknown;
  text: string;
  speaker?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  occurredAt: unknown;
  userId?: string | null;
  vertical?: string | null;
}

/** Priority of a read an answer cited before it was understood (0168). */
const PRIORITY_ANSWER = 2;

/** Turns relearned per answer — the ones the answer cites, not the session. */
const MAX_TURNS = 4;

/**
 * Memory learns from the answers it had to read raw.
 *
 * When the facts could not answer a question and L3 answered it from the
 * raw turns, the extraction of those turns missed something a reader
 * needed. Serving the raw text answers THIS question, at the price of an
 * escalation, every time it is asked; the memory itself stays as blind as
 * it was, and so does everything that reads facts rather than turns —
 * the profile, the timeline, the conflict machinery, the nightly passes.
 *
 * So the turns the answer cites are read again with the question and the
 * answer as the extractor's focus (memory-context `focus`), as a run of
 * their own document (IndexerRunService.runFocused: one read per
 * document and question); the resolver decides as always — a fact the
 * memory already held corroborates, a new one is inserted, a changed one
 * supersedes. Grounding is unchanged: a fact's value must still be a
 * verbatim span of the turn, so the focus can direct the reading, never
 * invent it.
 *
 * A lesson is a job on the queue (`relearn_turn`, keyed by turn and
 * question): it survives a restart, runs on the offline tier, retries,
 * and is taught once. It used to be a promise chain in the process that
 * re-posted the turn as a document — which the content hash deduplicated
 * onto the turn's own, already-read document whenever the turn WAS the
 * document (every conversation turn): the lesson read nothing.
 */
@Injectable()
export class RelearnFromRawService implements OnModuleInit {
  private readonly logger = new Logger(RelearnFromRawService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly documents: DocumentIngestService,
    private readonly runs: IndexerRunService,
    private readonly commit: CandidateCommitService,
    private readonly store: DocumentStoreService,
    private readonly candidates: CandidateStoreService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly batch?: ExtractionBatchService,
    @Optional() private readonly metrics?: ExtractionMetrics,
  ) {}

  onModuleInit(): void {
    this.workerLoop?.register(
      'relearn_turn',
      async (ctx) => {
        const p = ctx.payload ?? {};
        const out = await this.relearnTurn({
          companyId: ctx.companyId,
          userId: typeof p.userId === 'string' ? p.userId : undefined,
          episodeId: String(p.episodeId ?? ''),
          question: String(p.question ?? ''),
          answer: String(p.answer ?? ''),
          factCited: p.factCited === true,
        });
        return { ...out };
      },
      { ttlSeconds: 600, maxAttempts: 3 },
    );
  }

  /** Queue the lessons and return at once — the caller is serving an answer. */
  schedule(req: RelearnRequest): void {
    const episodeIds = [...new Set(req.episodeIds)].slice(0, MAX_TURNS);
    if (episodeIds.length === 0) return;
    if (!this.claim) {
      void this.relearn({ ...req, episodeIds }).catch((e: Error) =>
        this.logger.warn(`[relearn] ${req.companyId}: ${e.message}`),
      );
      return;
    }
    for (const episodeId of episodeIds) {
      void this.claim
        .enqueue({
          jobType: 'relearn_turn',
          companyId: req.companyId,
          triggeredBy: 'manual',
          dedupKey: `relearn_${idTailOf(episodeId)}_${questionKey(req.question)}`,
          payload: {
            episodeId,
            question: clip(req.question),
            answer: clip(req.answer),
            ...(req.factCited ? { factCited: true } : {}),
            ...(req.userId !== undefined ? { userId: req.userId } : {}),
          },
        })
        .catch((e: Error) => this.logger.warn(`[relearn] enqueue ${req.companyId}: ${e.message}`));
    }
  }

  /** Every lesson of one answer, now; exposed for the admin path and the tests. */
  async relearn(req: RelearnRequest): Promise<{ turns: number; facts: number }> {
    let turns = 0;
    let facts = 0;
    for (const episodeId of [...new Set(req.episodeIds)].slice(0, MAX_TURNS)) {
      const out = await this.relearnTurn({ ...req, episodeId });
      turns += out.turns;
      facts += out.facts;
    }
    traceArtifact('relearn.from_raw', { turns, facts });
    this.logger.log(
      `[relearn] ${req.companyId}: ${turns} raw turn(s) read again for «${clip(req.question, 80)}» — ${facts} fact(s) committed`,
    );
    return { turns, facts };
  }

  /** One lesson: read the turn again with the focus, then commit its document. */
  private async relearnTurn(req: {
    companyId: string;
    userId?: string | undefined;
    episodeId: string;
    question: string;
    answer: string;
    factCited?: boolean | undefined;
  }): Promise<{ turns: number; facts: number }> {
    const turn = await this.turnOf(req.companyId, req.episodeId);
    if (!turn) return { turns: 0, facts: 0 };
    // A turn is relearned in its own scope: the lesson from one user's
    // raw text lands in that user's memory, never the tenant's.
    const userId = turn.userId ?? undefined;
    if (userId !== undefined && userId !== (req.userId ?? undefined)) return { turns: 0, facts: 0 };
    const focus = { question: clip(req.question), answer: clip(req.answer) };
    const doc = await this.documentOf(req.companyId, turn);
    if (!doc) {
      // A turn no document holds (written before documents carried their
      // turns): it becomes one, read with the focus by the queue.
      await this.documents.ingestDocument(
        req.companyId,
        {
          kind: 'chat',
          text: turn.text,
          occurredAt: isoOf(turn.occurredAt),
          ...(userId !== undefined ? { userId } : {}),
          contextRef: { vertical: turn.vertical ?? 'relearn', recorder: 'relearn' },
          indexers: 'general',
        },
        {
          channel: 'relearn',
          internal: internalDocumentMeta({
            episodeId: String(turn.id),
            conversationId: turn.conversationId ?? undefined,
            messageId: turn.messageId ?? undefined,
            speakerName: turn.speaker ?? undefined,
            focusQuestion: focus.question,
            focusAnswer: focus.answer,
          }),
        },
      );
      return { turns: 1, facts: 0 };
    }
    // Cited before it was understood (unread, or kept raw): it is read in
    // full, ahead of the backlog — the question is answered, and the read
    // it was waiting for is what the memory lacks (§4.2 T-3).
    const promoted = await this.candidates
      .promote(req.companyId, {
        packId: GENERAL_INDEXER_ID,
        packVersion: GENERAL_INDEXER_VERSION,
        priority: PRIORITY_ANSWER,
        target: { docIds: [doc.id] },
      })
      .catch(() => 0);
    if (promoted > 0) {
      this.metrics?.promoted('answer', promoted);
      await this.batch?.schedule(req.companyId, { delayMs: 1000 });
      return { turns: 1, facts: 0 };
    }
    // Read already, and the answer rested on facts too: nothing to teach.
    if (req.factCited) return { turns: 0, facts: 0 };
    const run = await this.runs.runFocused({
      companyId: req.companyId,
      doc,
      text: turn.text,
      focus,
    });
    if (run.status !== 'succeeded') return { turns: 1, facts: 0 };
    const result = await this.commit.commitIfRunsSettled(req.companyId, doc);
    if (result.committed) {
      await this.store
        .setStatus({ companyId: req.companyId, docId: doc.id, status: 'committed' })
        .catch(() => undefined);
    }
    return { turns: 1, facts: result.factIds.length };
  }

  private async turnOf(companyId: string, episodeId: string): Promise<EpisodeRow | null> {
    const [turn] = await this.surreal.withCompany(companyId, (db) =>
      queryRows<EpisodeRow>(
        db,
        `SELECT id, text, speaker, conversationId, messageId, occurredAt, userId,
                source.vertical AS vertical
           FROM episode WHERE id = $id`,
        { id: new StringRecordId(episodeId) },
      ),
    );
    return turn ?? null;
  }

  /**
   * The document that holds the turn: a conversation turn's own document
   * names it (meta.episodeId); a posted document keeps its turns under
   * `document:<id>`.
   */
  private async documentOf(companyId: string, turn: EpisodeRow): Promise<StoredDocument | null> {
    const conv = turn.conversationId ?? '';
    const docId = conv.startsWith('document:')
      ? conv.slice('document:'.length)
      : await this.surreal.withCompany(companyId, async (db) => {
          const [row] = await queryRows<{ id: unknown }>(
            db,
            `SELECT id FROM source_document WHERE meta.episodeId = $ep LIMIT 1`,
            { ep: String(turn.id) },
          );
          return row ? String(row.id) : null;
        });
    return docId ? this.store.getById(companyId, docId) : null;
  }
}

/** One lesson per turn and question: the question is the key. */
function questionKey(question: string): string {
  return createHash('sha256')
    .update(question.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
}

function clip(text: string, n = INTERNAL_DOCUMENT_META_MAX_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date(String(value)).toISOString();
}
