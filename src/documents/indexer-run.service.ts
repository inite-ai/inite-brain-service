import { createHash } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ExtractorService, type ConversationContext } from '../ai/extractor.service';
import type { ExtractionResult } from '../ai/extractor-internals/types';
import { MetricsService } from '../metrics/metrics.service';
import { traceSpan } from '../common/debug-trace';
import { MemoryContextService } from '../ingest/memory-context.service';
import { internalMetaString, participantsFromMeta, splitKnownNames } from './document-meta';
import { isUserEntityRef } from '../ingest/user-entity';
import {
  CandidateBatch,
  GENERAL_INDEXER_ID,
  GENERAL_INDEXER_VERSION,
  IndexerExecutionMode,
} from '../indexers/candidate.types';
import { CandidateStoreService } from './candidate-store.service';
import type { DocumentChunk } from './chunker';
import type { StoredDocument } from './document-store.service';
import { renderGroup, splitGroupResult, type GroupDoc } from './extraction-group';

export interface IndexerRunResult {
  runId: string;
  packId: string;
  /** 'planned' = an external work item was registered, no extraction ran. */
  status: 'succeeded' | 'skipped' | 'failed' | 'planned';
  stats?: {
    chunks: number;
    entities: number;
    facts: number;
    relations: number;
    durationMs: number;
  };
}

/** One indexer execution over a document, supplied by the dispatcher. */
export interface IndexerRunSpec {
  companyId: string;
  doc: StoredDocument;
  chunks: DocumentChunk[];
  packId: string;
  packVersion: string;
  executionMode: IndexerExecutionMode;
  model: string;
  registryVersionHash?: string | undefined;
  /** The actual extraction — union or pack-scoped dedicated. */
  extract: (chunkText: string) => Promise<ExtractionResult>;
  /**
   * Job abort (pod shutdown / lost claim). Checked between chunks so a
   * deploy finalizes the run 'failed' instead of orphaning it 'running';
   * createRun then reopens it on the retry. Absent on the sync HTTP path.
   */
  abortSignal?: AbortSignal | undefined;
}

/**
 * The Indexer layer's staging engine: run ONE indexer (any execution
 * mode) over a document's chunks and stage the output as candidates.
 * Which indexers run — and with what extraction — is the dispatcher's
 * decision; this service owns the run ledger + candidate staging only.
 *
 * Idempotent per (doc, packId, packVersion): the indexer_run UNIQUE
 * index makes a re-run a skip, which is what re-POSTs and re-index
 * backfills lean on.
 */
@Injectable()
export class IndexerRunService {
  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly extractor: ExtractorService,
    private readonly candidates: CandidateStoreService,
    private readonly memory: MemoryContextService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * The pack-less generalist ('_general') pass — today's union extractor
   * as an indexer. Virtual composition happens at the candidate level:
   * fact rows attribute their owning pack by predicate namespace, so
   * "one document, N indexers" is true with zero extra LLM calls.
   */
  async runGeneral(p: {
    companyId: string;
    doc: StoredDocument;
    chunks: DocumentChunk[];
    abortSignal?: AbortSignal;
    /** Queued extraction of a captured document (extractor `background`). */
    background?: boolean;
  }): Promise<IndexerRunResult> {
    return this.runIndexer({
      companyId: p.companyId,
      doc: p.doc,
      chunks: p.chunks,
      packId: GENERAL_INDEXER_ID,
      packVersion: GENERAL_INDEXER_VERSION,
      executionMode: 'virtual',
      model: this.extractor.modelId(),
      registryVersionHash: await this.extractor.vocabularyVersionHash(p.companyId),
      extract: async (chunkText) => {
        const context = await this.extractionContext(p.companyId, p.doc, chunkText);
        return p.background
          ? this.extractor.extractBackground({ text: chunkText, companyId: p.companyId, context })
          : this.extractor.extract(chunkText, p.companyId, context);
      },
      abortSignal: p.abortSignal,
    });
  }

  /**
   * What the extractor is told about this chunk beyond its text: who
   * spoke it (the participants the mention wrapper threaded through the
   * internal meta) and what the memory already holds around it — the
   * conversation so far, the entities it names, their facts, the
   * tenant's predicates (MemoryContextService). Built per chunk because
   * the names differ per chunk; the conversation reads are the same and
   * cheap.
   */
  private async extractionContext(
    companyId: string,
    doc: StoredDocument,
    chunkText: string,
  ): Promise<ConversationContext> {
    const { speaker, addressee } = participantsFromMeta(doc.meta);
    const speakerName = speaker?.name;
    const addresseeName = addressee?.name;
    const memory = await this.memory.build({
      companyId,
      text: chunkText,
      occurredAt: doc.occurredAt,
      before: doc.occurredAt,
      conversationId: internalMetaString(doc.meta, 'conversationId'),
      messageId: internalMetaString(doc.meta, 'messageId'),
      userId: doc.userId,
      // The caller's anchors first (participants among them): what the
      // caller says the turn is about is looked up before what NER finds.
      participants: [
        ...new Set(
          [
            speakerName,
            addresseeName,
            ...splitKnownNames(internalMetaString(doc.meta, 'knownNames')),
          ].filter((n): n is string => !!n),
        ),
      ],
    });
    // Relearn from raw: the question this turn answered only when read
    // raw rides the document header into the extractor's context.
    const question = internalMetaString(doc.meta, 'focusQuestion');
    const answer = internalMetaString(doc.meta, 'focusAnswer');
    const focus = question && answer ? { question, answer } : undefined;
    const withFocus = focus
      ? {
          ...(memory ?? { recentTurns: [], entities: [], facts: [], predicates: [] }),
          focus,
        }
      : memory;
    return {
      ...(speakerName ? { speakerName } : {}),
      ...(isUserEntityRef(speaker, doc.userId) ? { speakerIsUser: true } : {}),
      ...(addresseeName ? { addresseeName } : {}),
      ...(withFocus ? { memory: withFocus } : {}),
    };
  }

  /**
   * A focused re-read (relearn-from-raw): one turn of an already-read
   * document read again with the question it had to answer from raw as
   * the extractor's focus. It is its OWN run in the ledger —
   * `_relearn@<general version>.<question key>` — because the document's
   * generalist run is long terminal and a second read of it is not a
   * retry of the first: one read per (document, question), idempotent
   * like every run. Its candidates join the document's next commit.
   */
  async runFocused(p: {
    companyId: string;
    doc: StoredDocument;
    text: string;
    focus: { question: string; answer: string };
    abortSignal?: AbortSignal;
  }): Promise<IndexerRunResult> {
    const key = createHash('sha256').update(p.focus.question).digest('hex').slice(0, 16);
    return this.runIndexer({
      companyId: p.companyId,
      doc: p.doc,
      chunks: [{ seq: 0, text: p.text, charStart: 0, charEnd: p.text.length }],
      packId: RELEARN_INDEXER_ID,
      packVersion: `${GENERAL_INDEXER_VERSION}.${key}`,
      executionMode: 'virtual',
      model: this.extractor.modelId(),
      registryVersionHash: await this.extractor.vocabularyVersionHash(p.companyId),
      extract: async (text) =>
        this.extractor.extractBackground({
          text,
          companyId: p.companyId,
          // The focus rides the header, as it does for a document written
          // to be relearned (the stored row is not touched).
          context: await this.extractionContext(
            p.companyId,
            {
              ...p.doc,
              meta: {
                ...p.doc.meta,
                focusQuestion: p.focus.question,
                focusAnswer: p.focus.answer,
              },
            },
            text,
          ),
        }),
      abortSignal: p.abortSignal,
    });
  }

  /**
   * The generalist pass over SEVERAL captured documents in one extraction
   * (extraction-group.ts): each document's pending run is claimed, the
   * group is read once as CURRENT TURNS, and every document stages the
   * candidates whose clauses its own text holds — on its own run, so the
   * commit, the ledger and a later re-read stay per document. Documents
   * whose run another worker already holds are left to it. A failed read
   * fails every claimed run (they are reopened on the next pass).
   */
  async runGeneralGroup(p: {
    companyId: string;
    docs: StoredDocument[];
    texts: Map<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<IndexerRunResult[]> {
    const startedAt = Date.now();
    const model = this.extractor.modelId();
    const registryVersionHash = await this.extractor.vocabularyVersionHash(p.companyId);
    const claimed: Array<{ doc: StoredDocument; runId: string }> = [];
    const results: IndexerRunResult[] = [];
    for (const doc of p.docs) {
      const run = await this.candidates.createRun(p.companyId, {
        docId: doc.id,
        packId: GENERAL_INDEXER_ID,
        packVersion: GENERAL_INDEXER_VERSION,
        model,
        registryVersionHash,
      });
      if (run.created) claimed.push({ doc, runId: run.runId });
      else results.push({ runId: run.runId, packId: GENERAL_INDEXER_ID, status: 'skipped' });
    }
    if (claimed.length === 0) return results;

    const groupDocs = claimed.map(({ doc }) => groupDocOf(doc, p.texts.get(doc.id) ?? ''));
    try {
      if (p.abortSignal?.aborted) throw new Error('aborted');
      const rendered = renderGroup(groupDocs);
      const extraction = await traceSpan(
        'indexer.run.extract_group',
        async () =>
          this.extractor.extractBackground({
            text: rendered.text,
            companyId: p.companyId,
            context: {
              turns: rendered.turns,
              ...(await this.groupMemory(p.companyId, claimed, groupDocs)),
            },
          }),
        { packId: GENERAL_INDEXER_ID, documents: claimed.length },
      );
      const perDoc = splitGroupResult(groupDocs, extraction);
      for (const [i, { doc, runId }] of claimed.entries()) {
        const part = perDoc[i] as ExtractionResult;
        const counts = await this.candidates.insertBatch(p.companyId, {
          docId: doc.id,
          runId,
          chunkSeq: 0,
          batch: {
            provenance: {
              indexerId: GENERAL_INDEXER_ID,
              packVersion: GENERAL_INDEXER_VERSION,
              executionMode: 'virtual',
              model,
            },
            entities: part.entities.map((e, k) => ({ ...e, entityIndex: k })),
            facts: part.facts,
            relations: part.edges,
          },
        });
        const stats = { chunks: 1, ...counts, durationMs: Date.now() - startedAt };
        await this.candidates.finalizeRun(p.companyId, { runId, status: 'succeeded', stats });
        this.metrics?.countIndexerRun('succeeded');
        results.push({ runId, packId: GENERAL_INDEXER_ID, status: 'succeeded', stats });
      }
      return results;
    } catch (err) {
      for (const { runId } of claimed) {
        await this.candidates
          .finalizeRun(p.companyId, {
            runId,
            status: 'failed',
            error: { message: (err as Error).message },
          })
          .catch(() => undefined);
        this.metrics?.countIndexerRun('failed');
      }
      throw err;
    }
  }

  /**
   * The memory a group is read against: what the graph holds about every
   * name its turns carry, and the conversation BEFORE its first turn.
   */
  private async groupMemory(
    companyId: string,
    claimed: Array<{ doc: StoredDocument }>,
    groupDocs: GroupDoc[],
  ): Promise<Pick<ConversationContext, 'memory'>> {
    const first = claimed[0]?.doc as StoredDocument;
    const names = claimed.flatMap(({ doc }) => {
      const { speaker, addressee } = participantsFromMeta(doc.meta);
      return [
        speaker?.name,
        addressee?.name,
        ...splitKnownNames(internalMetaString(doc.meta, 'knownNames')),
      ];
    });
    const memory = await this.memory.build({
      companyId,
      text: groupDocs.map((d) => d.text).join('\n\n'),
      occurredAt: first.occurredAt,
      before: first.occurredAt,
      conversationId: groupDocs[0]?.conversationId,
      userId: first.userId,
      participants: [...new Set(names.filter((n): n is string => !!n))],
    });
    return memory ? { memory } : {};
  }

  /**
   * Register an EXTERNAL pack's work item: a 'pending' external
   * indexer_run served by the pull API (GET /v1/indexer/work). Nothing
   * extracts in-process — the remote indexer claims the run, reads the
   * stored content, and submits candidates. Idempotent per
   * (doc, packId, packVersion) like every run; an existing row in any
   * state is left untouched.
   */
  async planExternal(p: {
    companyId: string;
    docId: string;
    packId: string;
    packVersion: string;
  }): Promise<IndexerRunResult> {
    await this.candidates.ensureRunPending(p.companyId, {
      docId: p.docId,
      packId: p.packId,
      packVersion: p.packVersion,
      external: true,
    });
    return { runId: '', packId: p.packId, status: 'planned' };
  }

  async runIndexer(spec: IndexerRunSpec): Promise<IndexerRunResult> {
    const startedAt = Date.now();
    const run = await this.candidates.createRun(spec.companyId, {
      docId: spec.doc.id,
      packId: spec.packId,
      packVersion: spec.packVersion,
      model: spec.model,
      registryVersionHash: spec.registryVersionHash,
    });
    if (!run.created) {
      this.metrics?.countIndexerRun('skipped_duplicate');
      return { runId: run.runId, packId: spec.packId, status: 'skipped' };
    }

    const stats = { chunks: 0, entities: 0, facts: 0, relations: 0, durationMs: 0 };
    try {
      for (const chunk of spec.chunks) {
        if (spec.abortSignal?.aborted) {
          // Pod shutdown / lost claim mid-run: fail fast so the run row
          // becomes terminal (reap-able / reopenable) instead of stuck.
          throw new Error('aborted');
        }
        const extraction = await traceSpan('indexer.run.extract', () => spec.extract(chunk.text), {
          packId: spec.packId,
          chunkSeq: chunk.seq,
        });
        const batch: CandidateBatch = {
          provenance: {
            indexerId: spec.packId,
            packVersion: spec.packVersion,
            executionMode: spec.executionMode,
            model: spec.model,
          },
          entities: extraction.entities.map((e, i) => ({ ...e, entityIndex: i })),
          facts: extraction.facts,
          relations: extraction.edges,
        };
        const counts = await this.candidates.insertBatch(spec.companyId, {
          docId: spec.doc.id,
          runId: run.runId,
          chunkSeq: chunk.seq,
          batch,
        });
        stats.chunks += 1;
        stats.entities += counts.entities;
        stats.facts += counts.facts;
        stats.relations += counts.relations;
      }
      stats.durationMs = Date.now() - startedAt;
      await this.candidates.finalizeRun(spec.companyId, {
        runId: run.runId,
        status: 'succeeded',
        stats,
      });
      this.metrics?.countIndexerRun('succeeded');
      return { runId: run.runId, packId: spec.packId, status: 'succeeded', stats };
    } catch (err) {
      await this.candidates
        .finalizeRun(spec.companyId, {
          runId: run.runId,
          status: 'failed',
          error: { message: (err as Error).message },
        })
        .catch(() => undefined);
      this.metrics?.countIndexerRun('failed');
      throw err;
    }
  }
}

/** A stored document as an extraction-group member. */
export function groupDocOf(doc: StoredDocument, text: string): GroupDoc {
  const { speaker, addressee } = participantsFromMeta(doc.meta);
  return {
    id: doc.id,
    text,
    occurredAt: doc.occurredAt,
    chunkCount: doc.chunkCount,
    userId: doc.userId,
    conversationId: internalMetaString(doc.meta, 'conversationId'),
    speakerName: speaker?.name,
    speakerIsUser: isUserEntityRef(speaker, doc.userId) || undefined,
    addresseeName: addressee?.name,
  };
}

/** The ledger's pack id of a focused re-read (runFocused). */
export const RELEARN_INDEXER_ID = '_relearn';
