import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService, runTransaction } from '../db/surreal.service';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { scopeForUser } from '../auth/scope-tags';
import { segmentSessions, type EpisodeRow } from './window-deriver.service';

/**
 * L0 segment composer (memory-rebuild R1,
 * docs/roadmap/memory-rebuild-2026-07.md §2).
 *
 * Batch-derives `episode_segment` rows — verbatim sliding windows of
 * WINDOW turns (stride STRIDE) within each session — from the immutable
 * episode substrate. LLM-free: segmentation is positional (SeCom-style
 * topical segmentation is the v2 upgrade if the positional baseline
 * measures well), the only paid step is one embedding batch per
 * conversation. Idempotent per conversation, and atomic (audit W2 #10):
 * the paid embedding batch runs BEFORE any delete, then the old window
 * set is swapped for the new one in a single transaction — the segment
 * lane never reads a conversation mid-rebuild (the old delete-then-
 * embed-then-insert left it empty for the whole embedding call, and a
 * crashed run left it empty until the next rebuild).
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
        t.occurredAt instanceof Date ? t.occurredAt.toISOString() : t.occurredAt,
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
    // One generation stamp per run: every row written by this rebuild
    // carries it, so a partially-failed run is observable (conversations
    // on the old generation = the ones whose swap never landed).
    const generation = new Date().toISOString();
    await this.surreal.withCompany(companyId, async (db) => {
      const convs = await this.episodes.conversationCounts(db);
      for (const conv of convs) {
        const conversationId = conv.conversationId;
        try {
          await this.composeConversation({
            db,
            conversationId,
            result,
            generation,
          });
          result.conversations += 1;
        } catch (e) {
          result.skipped.push({ conversationId, reason: (e as Error).message });
          this.logger.warn(`segment compose failed for ${conversationId}: ${(e as Error).message}`);
        }
      }
    });
    return result;
  }

  private async composeConversation({
    db,
    conversationId,
    result,
    generation,
  }: {
    db: {
      query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
    };
    conversationId: string;
    result: SegmentRunResult;
    generation: string;
  }): Promise<void> {
    const episodes: SegmentEpisodeRow[] = await this.episodes.conversationTurnsRaw(
      db,
      conversationId,
    );
    if (episodes.length === 0) return;

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

    // Paid step BEFORE any delete: an embedding failure now leaves the
    // old window set intact instead of an emptied conversation.
    const texts = windows.map((w) => renderSegmentText(w.turns));
    const vectors = await this.embedding.embedMany(texts);
    // One multi-row INSERT per conversation — per-segment CREATEs cost a
    // round trip each (Surreal-usage audit §9).
    const rows = windows.map((w, i) => {
      const pii = [...new Set(w.turns.flatMap((t) => t.piiClass ?? []))];
      const userIds = [...new Set(w.turns.map((t) => t.userId).filter((u): u is string => !!u))];
      return {
        conversationId,
        seq: w.seq,
        episodeIds: w.turns.map((t) => new StringRecordId(String(t.id))),
        text: texts[i],
        occurredAt: new Date(w.turns[0]!.occurredAt as string), // windows are non-empty
        piiClass: pii.length > 0 ? pii : undefined,
        userId: userIds.length === 1 ? userIds[0] : undefined,
        // G6 step 1: mirror the per-user scope as a scope tag (0093).
        // A mixed-user window stays tenant-global ([]) — same rule as
        // the userId stamp above.
        scope: scopeForUser(userIds.length === 1 ? userIds[0] : undefined),
        embedding: vectors[i],
        recorder: SEGMENT_RECORDER,
        generation,
      };
    });
    // Atomic swap: old windows out, new windows in, one transaction —
    // readers see the previous set or the new set, never neither. The
    // delete must precede the insert INSIDE the transaction: (conv, seq)
    // is UNIQUE and the new generation reuses the same seq values.
    await runTransaction(db as unknown as Surreal, (tx) =>
      tx
        .add(`DELETE episode_segment WHERE conversationId = $conv`)
        .add(`INSERT INTO episode_segment $rows`)
        .bind('conv', conversationId)
        .bind('rows', rows),
    );
    result.segments += rows.length;
  }
}
