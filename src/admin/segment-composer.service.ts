import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
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
    private readonly episodes: EpisodeReadStoreService,
  ) {}

  async run(companyId: string): Promise<SegmentRunResult> {
    const result: SegmentRunResult = {
      conversations: 0,
      segments: 0,
      skipped: [],
    };
    await this.surreal.withCompany(companyId, async (db) => {
      const convs = await this.episodes.conversationCounts(db);
      for (const conv of convs) {
        const conversationId = conv.conversationId;
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
    const episodes: SegmentEpisodeRow[] =
      await this.episodes.conversationTurns(db, conversationId);
    if (episodes.length === 0) return;

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
    // One multi-row INSERT per conversation — per-segment CREATEs cost a
    // round trip each (Surreal-usage audit §9).
    const rows = windows.map((w, i) => {
      const pii = [...new Set(w.turns.flatMap((t) => t.piiClass ?? []))];
      const userIds = [
        ...new Set(
          w.turns.map((t) => t.userId).filter((u): u is string => !!u),
        ),
      ];
      return {
        conversationId,
        seq: w.seq,
        episodeIds: w.turns.map((t) => new StringRecordId(String(t.id))),
        text: texts[i],
        occurredAt: new Date(w.turns[0].occurredAt as string),
        piiClass: pii.length > 0 ? pii : undefined,
        userId: userIds.length === 1 ? userIds[0] : undefined,
        embedding: vectors[i],
        recorder: SEGMENT_RECORDER,
      };
    });
    await db.query(`INSERT INTO episode_segment $rows`, { rows });
    result.segments += rows.length;
  }
}
