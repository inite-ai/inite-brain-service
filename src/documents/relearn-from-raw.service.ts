import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService, queryRows } from '../db/surreal.service';
import { DocumentIngestService } from './document-ingest.service';
import { internalDocumentMeta, INTERNAL_DOCUMENT_META_MAX_CHARS } from './document-meta';
import { traceArtifact } from '../common/debug-trace';

export interface RelearnRequest {
  companyId: string;
  userId?: string | undefined;
  /** The raw turns the answer was read from (L3 episode citations). */
  episodeIds: string[];
  question: string;
  answer: string;
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
 * So the turns the answer cites are read again, through the document
 * pipeline the rest of the memory is written by, with the question and
 * the answer as the extractor's focus (memory-context `focus`). The
 * document names the turn it re-reads (`episodeId`), so no turn is
 * captured twice and every fact it yields walks back to the same raw
 * text; the resolver decides as always — a fact the memory already held
 * corroborates, a new one is inserted, a changed one supersedes.
 * Grounding is unchanged: a fact's value must still be a verbatim span
 * of the turn, so the focus can direct the reading, never invent it.
 *
 * Off the request path and best-effort: a failure costs nothing but the
 * lesson, and the next escalation on the same question teaches it again.
 * One lesson per (turn, question) per process.
 */
@Injectable()
export class RelearnFromRawService {
  private readonly logger = new Logger(RelearnFromRawService.name);
  private readonly taught = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly surreal: SurrealService,
    private readonly documents: DocumentIngestService,
  ) {}

  /** Queue the lesson and return at once — the caller is serving an answer. */
  schedule(req: RelearnRequest): void {
    const episodeIds = [...new Set(req.episodeIds)]
      .filter((id) => !this.taught.has(`${id}|${req.question}`))
      .slice(0, MAX_TURNS);
    if (episodeIds.length === 0) return;
    for (const id of episodeIds) this.taught.add(`${id}|${req.question}`);
    // One lesson at a time: each is a handful of extractor calls, and a
    // burst of escalations must not become a burst of them.
    this.chain = this.chain
      .then(async () => {
        await this.relearn({ ...req, episodeIds });
      })
      .catch((e: Error) => this.logger.warn(`[relearn] ${req.companyId}: ${e.message}`));
  }

  /** The lesson itself; exposed for the admin path and the tests. */
  async relearn(req: RelearnRequest): Promise<{ turns: number; facts: number }> {
    const turns = await this.surreal.withCompany(req.companyId, (db) =>
      queryRows<EpisodeRow>(
        db,
        `SELECT id, text, speaker, conversationId, messageId, occurredAt, userId,
                source.vertical AS vertical
           FROM episode WHERE id INSIDE $ids`,
        { ids: req.episodeIds.map((id) => new StringRecordId(id)) },
      ),
    );
    let facts = 0;
    for (const turn of turns) {
      // A turn is relearned in its own scope: the lesson from one user's
      // raw text lands in that user's memory, never the tenant's.
      const userId = turn.userId ?? undefined;
      if (userId !== (req.userId ?? undefined) && userId !== undefined) continue;
      const res = await this.documents.ingestDocument(
        req.companyId,
        {
          kind: 'chat',
          text: turn.text,
          occurredAt: isoOf(turn.occurredAt),
          ...(userId !== undefined ? { userId } : {}),
          contextRef: { vertical: turn.vertical ?? 'relearn', recorder: 'relearn' },
          indexers: 'general',
          mode: 'sync',
        },
        {
          channel: 'relearn',
          internal: internalDocumentMeta({
            episodeId: String(turn.id),
            conversationId: turn.conversationId ?? undefined,
            messageId: turn.messageId ?? undefined,
            speakerName: turn.speaker ?? undefined,
            focusQuestion: clip(req.question),
            focusAnswer: clip(req.answer),
          }),
        },
      );
      facts += res.committed.factIds.length;
    }
    traceArtifact('relearn.from_raw', { turns: turns.length, facts });
    this.logger.log(
      `[relearn] ${req.companyId}: ${turns.length} raw turn(s) read again for «${clip(req.question, 80)}» — ${facts} fact(s) committed`,
    );
    return { turns: turns.length, facts };
  }
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
