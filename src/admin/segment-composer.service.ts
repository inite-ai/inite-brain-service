import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import {
  segmentSessions,
  type EpisodeRow,
} from './window-deriver.service';

/**
 * L0 segment composer (memory-rebuild R1,
 * docs/roadmap/memory-rebuild-2026-07.md §2).
 *
 * Batch-derives `episode_segment` rows — verbatim sliding windows of
 * WINDOW turns (stride STRIDE) within each session — from the immutable
 * episode substrate. LLM-free: segmentation is positional (SeCom-style
 * topical segmentation is the v2 upgrade if the positional baseline
 * measures well), the only paid step is one embedding batch per
 * conversation. Idempotent: delete-by-conversation, then insert.
 */
export const SEGMENT_RECORDER = 'segment-composer-v1';
const WINDOW = 4;
const STRIDE = 2;

export interface SegmentRunResult {
  conversations: number;
  segments: number;
  skipped: Array<{ conversationId: string; reason: string }>;
}

interface SegmentEpisodeRow extends EpisodeRow {
  piiClass?: string[];
  userId?: string;
}

/** Pure: sliding windows over one session's time-ordered turns. */
export function windowSession(
  turns: SegmentEpisodeRow[],
  window: number = WINDOW,
  stride: number = STRIDE,
): SegmentEpisodeRow[][] {
  if (turns.length === 0) return [];
  if (turns.length <= window) return [turns];
  const out: SegmentEpisodeRow[][] = [];
  for (let start = 0; start < turns.length; start += stride) {
    out.push(turns.slice(start, start + window));
    if (start + window >= turns.length) break;
  }
  return out;
}

export function renderSegmentText(turns: SegmentEpisodeRow[]): string {
  return turns
    .map((t) => {
      const day = String(
        t.occurredAt instanceof Date
          ? t.occurredAt.toISOString()
          : t.occurredAt,
      ).slice(0, 10);
      return `[${day}] ${t.speaker ?? 'unknown'}: ${t.text}`;
    })
    .join('\n');
}

@Injectable()
export class SegmentComposerService {
  private readonly logger = new Logger(SegmentComposerService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedding: FactEmbeddingService,
  ) {}

  async run(companyId: string): Promise<SegmentRunResult> {
    const result: SegmentRunResult = {
      conversations: 0,
      segments: 0,
      skipped: [],
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const [convs] = await db.query<
        [Array<{ conversationId?: string }>]
      >(
        `SELECT conversationId, count() AS n FROM episode
          WHERE conversationId IS NOT NONE
          GROUP BY conversationId`,
      );
      for (const conv of convs ?? []) {
        const conversationId = String(conv.conversationId);
        try {
          await this.composeConversation({ db, conversationId, result });
          result.conversations += 1;
        } catch (e) {
          result.skipped.push({ conversationId, reason: (e as Error).message });
          this.logger.warn(
            `segment compose failed for ${conversationId}: ${(e as Error).message}`,
          );
        }
      }
    });
    return result;
  }

  private async composeConversation({
    db,
    conversationId,
    result,
  }: {
    db: {
      query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
    };
    conversationId: string;
    result: SegmentRunResult;
  }): Promise<void> {
    const [episodes] = await db.query<[SegmentEpisodeRow[]]>(
      `SELECT id, speaker, text, occurredAt, piiClass, userId FROM episode
        WHERE conversationId = $conv ORDER BY occurredAt ASC LIMIT 5000`,
      { conv: conversationId },
    );
    if (!episodes || episodes.length === 0) return;

    await db.query(
      `DELETE episode_segment WHERE conversationId = $conv`,
      { conv: conversationId },
    );

    // Session boundaries first (same 60-min gap rule as the deriver), then
    // positional windows within each session — a segment never spans the
    // inactivity gap that separates two visits.
    const windows: Array<{ seq: number; turns: SegmentEpisodeRow[] }> = [];
    let seq = 0;
    for (const session of segmentSessions(episodes)) {
      for (const turns of windowSession(session as SegmentEpisodeRow[])) {
        windows.push({ seq, turns });
        seq += 1;
      }
    }
    if (windows.length === 0) return;

    const texts = windows.map((w) => renderSegmentText(w.turns));
    const vectors = await this.embedding.embedMany(texts);
    for (const [i, w] of windows.entries()) {
      const pii = [
        ...new Set(w.turns.flatMap((t) => t.piiClass ?? [])),
      ];
      const userIds = [
        ...new Set(
          w.turns.map((t) => t.userId).filter((u): u is string => !!u),
        ),
      ];
      await db.query(
        `CREATE episode_segment CONTENT {
           conversationId: $conv,
           seq: $seq,
           episodeIds: $eps,
           text: $text,
           occurredAt: $occurredAt,
           piiClass: $pii,
           userId: $userId,
           embedding: $embedding,
           recorder: $recorder
         }`,
        {
          conv: conversationId,
          seq: w.seq,
          eps: w.turns.map((t) => new StringRecordId(String(t.id))),
          text: texts[i],
          occurredAt: new Date(w.turns[0].occurredAt as string),
          pii: pii.length > 0 ? pii : undefined,
          userId: userIds.length === 1 ? userIds[0] : undefined,
          embedding: vectors[i],
          recorder: SEGMENT_RECORDER,
        },
      );
      result.segments += 1;
    }
  }
}
