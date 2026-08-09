import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import {
  bestMentionPerSession,
  dedupeMentionLines,
  extractOrderingTopic,
  filterMentions,
  MAX_MENTION_LINES,
  pickMentionLine,
  topicTerms,
  type ScanRow,
} from './mention-scan';

interface SegmentScanRow {
  id: unknown;
  text: string;
  occurredAt: Date | string;
  score?: number;
}

/**
 * Mention-scan lane (V9 §2, timelineEvidence='scan').
 *
 * Builds the mention record for ordering/sequence questions by
 * COVERAGE-first enumeration instead of top-K similarity: the topic
 * phrase extracted from the question is matched against the segment
 * record (BM25 + embedding against the TOPIC, not the whole question),
 * mentions are grouped into sessions by the deriver's inactivity-gap
 * convention, and ONE dated line per session-mention is emitted in
 * occurredAt order. The result rides the existing transcript section
 * under the MENTION RECORD header — zero prompt-builder changes.
 *
 * Same contracts as the sibling lanes: PII gate for callers without
 * brain:read_pii, fail-closed user scope, degrade to [] on any
 * failure. Reads no env — activation comes from the resolved profile.
 */
@Injectable()
export class MentionScanService {
  private readonly logger = new Logger(MentionScanService.name);

  /** Scan breadth: how many rows each leg contributes to the pool.
   *  Sized to cover every session of a BEAM-100K world several times
   *  over (~40 sessions × a handful of windows each), not top-K. */
  private static readonly SCAN_FETCH_CAP = 400;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async mentionLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    /** V10 §3: collapse near-duplicate aspect mentions (orderingFrame). */
    dedupeAspects?: boolean;
  }): Promise<string[]> {
    const topic = extractOrderingTopic(opts.query);
    const piiGate = opts.callerScopes.includes('brain:read_pii')
      ? ''
      : 'AND piiClass IS NONE';
    // Fail-closed user scope — same contract as the segment lane (0055).
    const userGate = opts.userId
      ? 'AND (userId IS NONE OR userId = $scopeUserId)'
      : 'AND userId IS NONE';
    const userParams = opts.userId ? { scopeUserId: opts.userId } : {};
    const k = MentionScanService.SCAN_FETCH_CAP;
    try {
      const topicVector = await this.embedder.embed(topic);
      const pool = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const [dense] = await db.query<[SegmentScanRow[]]>(
            `SELECT id, text, occurredAt,
                    vector::similarity::cosine(embedding, $q) AS score
               FROM episode_segment
              WHERE embedding != NONE ${piiGate} ${userGate}
              ORDER BY score DESC
              LIMIT $k`,
            { q: topicVector, k, ...userParams },
          );
          const [bm25] = await db.query<[SegmentScanRow[]]>(
            `SELECT id, text, occurredAt, search::score(1) AS score
               FROM episode_segment
              WHERE text @1@ $topic ${piiGate} ${userGate}
              ORDER BY score DESC
              LIMIT $k`,
            { topic, k, ...userParams },
          );
          return mergeLegs(dense ?? [], bm25 ?? []);
        },
      );
      const mentions = bestMentionPerSession(filterMentions(pool));
      if (mentions.length > MAX_MENTION_LINES) {
        this.logger.warn(
          `mention scan capped: ${mentions.length} session-mentions → ` +
            `${MAX_MENTION_LINES} (topic="${topic.slice(0, 60)}")`,
        );
      }
      const terms = topicTerms(topic);
      const lines = mentions
        .slice(0, MAX_MENTION_LINES)
        .map((m) => pickMentionLine(m.text, terms))
        .filter((l) => l.length > 0);
      return opts.dedupeAspects ? dedupeMentionLines(lines) : lines;
    } catch (e) {
      this.logger.warn(
        `mention scan failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}

/** Union the dense and lexical pools by record id into ScanRows. */
function mergeLegs(
  dense: SegmentScanRow[],
  bm25: SegmentScanRow[],
): ScanRow[] {
  const byId = new Map<string, ScanRow>();
  for (const r of dense) {
    byId.set(String(r.id), {
      id: String(r.id),
      text: r.text,
      occurredAt: new Date(r.occurredAt as string).getTime(),
      sim: typeof r.score === 'number' ? r.score : undefined,
    });
  }
  for (const r of bm25) {
    const id = String(r.id);
    const prev = byId.get(id);
    if (prev) {
      prev.lex = typeof r.score === 'number' ? r.score : 1;
    } else {
      byId.set(id, {
        id,
        text: r.text,
        occurredAt: new Date(r.occurredAt as string).getTime(),
        lex: typeof r.score === 'number' ? r.score : 1,
      });
    }
  }
  return [...byId.values()];
}
