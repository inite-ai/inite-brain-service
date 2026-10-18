import { Injectable, Logger } from '@nestjs/common';
import {
  sourceDeepenPerQuery,
  sourcePlaneEnabled,
  sourceProgressiveEnabled,
} from '../common/source-plane-flags';
import { idTailOf } from '../ingest/ingest-utils';
import { SurrealService } from '../db/surreal.service';
import { SourceItemService } from './source-item.service';

/**
 * Progressive indexing (W6): a retrieval hit on a manifest-only item
 * schedules its deepening.
 *
 * Doctrine 5 says "manifest always, content by policy". A connection
 * with `contentPolicy: 'manifest'` walks a whole org drive for the price
 * of a listing and reads nothing — cheap, and useless until something
 * asks for it. This is the half that makes it useful: every query runs a
 * bounded match against the CATALOGUE (titles and paths, which the walk
 * already recorded for free), records the hit, and queues the best few
 * for a real fetch.
 *
 * Three properties it is built to keep:
 *
 *  - **It never changes the answer it rides on.** The probe runs after
 *    retrieval, off the request's critical path, and its result is a
 *    JOB. The query that triggered the deepening does not see the
 *    content; the next one does. Pretending otherwise would mean
 *    blocking a search on a network fetch of an unknown file.
 *  - **A hit is not a read.** `hitCount` is the evidence that reading
 *    would have been worth it. Deepening is budgeted separately, so a
 *    flood of queries against a million-item drive costs a counter
 *    update, not a million fetches.
 *  - **It reads only what it already catalogued.** No walk, no
 *    checkpoint, no gone policy — a deepening can change what the
 *    connection has READ, never what it has SEEN.
 */
export interface DeepenCandidate {
  itemId: string;
  connectionId: string;
  title: string;
  score: number;
}

interface CandidateRow {
  id: unknown;
  connectionId: unknown;
  title?: string | null;
  path?: string | null;
  hitCount?: number | null;
}

/** Words too common to be evidence that a title matches a question. */
const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'for',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'what',
  'who',
  'when',
  'where',
  'why',
  'how',
  'did',
  'does',
  'do',
  'about',
  'with',
]);
const MIN_TERM = 3;
const MAX_TERMS = 6;
/** How many catalogue rows one probe may look at, per connection. */
const SCAN_LIMIT = 500;

@Injectable()
export class SourceDeepenService {
  private readonly logger = new Logger(SourceDeepenService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly items: SourceItemService,
  ) {}

  enabled(): boolean {
    return sourcePlaneEnabled() && sourceProgressiveEnabled();
  }

  /**
   * The catalogue rows one query matches, best first. Pure read: the
   * caller decides what to do with them.
   */
  async candidates(companyId: string, query: string): Promise<DeepenCandidate[]> {
    const terms = termsOf(query);
    if (terms.length === 0) return [];
    const rows = await this.surreal.withCompany(companyId, async (db) => {
      const [out] = await db.query<[CandidateRow[]]>(
        `SELECT id, connectionId, title, path, hitCount FROM source_item
          WHERE state != 'gone' AND deepenedAt IS NONE
            AND documentId IS NONE AND assetId IS NONE AND episodeId IS NONE
            AND connectionId IN (
              SELECT VALUE id FROM source_connection
               WHERE contentPolicy = 'manifest' AND status = 'active'
            )
          LIMIT $limit`,
        { limit: SCAN_LIMIT },
      );
      return out ?? [];
    });
    const scored: DeepenCandidate[] = [];
    for (const row of rows) {
      const haystack = `${row.title ?? ''} ${row.path ?? ''}`.toLowerCase();
      const hit = terms.filter((t) => haystack.includes(t)).length;
      if (hit === 0) continue;
      scored.push({
        itemId: String(row.id),
        connectionId: String(row.connectionId),
        title: row.title ?? row.path ?? String(row.id),
        // Matching more of the question beats having been asked before,
        // but a row people keep landing on wins its ties.
        score: hit + Math.min(row.hitCount ?? 0, 9) / 10,
      });
    }
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * One probe: match, record the hits, and hand back the few worth
   * fetching, grouped by connection. Never throws — a search must not
   * fail because a catalogue read did.
   */
  async probe(
    companyId: string,
    query: string,
  ): Promise<Array<{ connectionId: string; itemIds: string[] }>> {
    if (!this.enabled()) return [];
    try {
      const all = await this.candidates(companyId, query);
      if (all.length === 0) return [];
      await this.items.recordHits(
        companyId,
        all.slice(0, SCAN_LIMIT).map((c) => c.itemId),
      );
      const byConnection = new Map<string, string[]>();
      for (const c of all.slice(0, sourceDeepenPerQuery())) {
        const list = byConnection.get(c.connectionId) ?? [];
        list.push(c.itemId);
        byConnection.set(c.connectionId, list);
      }
      return [...byConnection].map(([connectionId, itemIds]) => ({ connectionId, itemIds }));
    } catch (e) {
      this.logger.warn(`deepen probe for ${companyId} failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** The dedup key one deepening job gets — one per (connection, item set, hour). */
  static dedupKey(connectionId: string, itemIds: readonly string[]): string {
    const slot = Math.floor(Date.now() / 3_600_000);
    const items = [...itemIds].sort().map(idTailOf).join('.');
    return `source_deepen_${idTailOf(connectionId)}_${items}_${String(slot)}`.slice(0, 200);
  }
}

/** The words of a query worth matching a filename against. */
export function termsOf(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const term = raw.trim();
    if (term.length < MIN_TERM || STOP.has(term)) continue;
    seen.add(term);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}
