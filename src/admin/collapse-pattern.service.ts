import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';

/**
 * Per-tenant learned cache of state-change collapse patterns.
 *
 * "Pattern" here is the source verb phrase the LLM observed in user
 * input (e.g. "moved to", "switched to", "переехал в") and "replacement"
 * is the present-state form it collapsed it to ("lives in", "now
 * prefers", "живёт в"). The chat router records each collapse the LLM
 * emits and replays them locally on future occurrences — closing the
 * loop the LLM was paying for every turn.
 *
 * The cache starts EMPTY on every tenant. There is no hardcoded seed
 * list — that was the explicit architectural objection (Sprint 3
 * discussion). Operators can review the learned set via admin CRUD
 * (Sprint 3+1) and the system learns from operation: first occurrence
 * pays the LLM round-trip, subsequent identical phrases are free.
 *
 * Matching is case-folded substring with word boundaries — same shape
 * the chat router uses for known-name resolution. Verb declension is
 * NOT collapsed: "moves" and "moved" are distinct entries the cache
 * fills independently. This is deliberate — abstracting morphology is
 * exactly the kind of magic phrase table we removed in Sprint 2.
 */
export interface CollapseSnapshot {
  /** patternLower → { pattern, replacement } — preserves the canonical
   *  casing operators wrote, while keying the scan by lowercase. */
  patterns: Map<
    string,
    { pattern: string; replacement: string }
  >;
}

const SNAPSHOT_TTL_MS = 60_000;

@Injectable()
export class CollapsePatternService {
  private readonly logger = new Logger(CollapsePatternService.name);
  // LRU-bounded per-tenant snapshot. See the audit's "P1 — unbounded
  // per-tenant Maps" finding — without the cap the cache grew linearly
  // with the lifetime tenant count of the process.
  private readonly cache: LRUCache<
    string,
    { snapshot: CollapseSnapshot; loadedAt: number }
  >;

  constructor(
    private readonly surreal: SurrealService,
    private readonly config: ConfigService,
  ) {
    const cap = parseInt(
      this.config.get<string>('COLLAPSE_PATTERN_CACHE_CAP', '200'),
      10,
    );
    this.cache = new LRUCache(cap);
  }

  async getSnapshot(companyId: string): Promise<CollapseSnapshot> {
    const cached = this.cache.get(companyId);
    if (cached && Date.now() - cached.loadedAt < SNAPSHOT_TTL_MS) {
      return cached.snapshot;
    }
    const fresh = await this.loadFresh(companyId);
    this.cache.set(companyId, { snapshot: fresh, loadedAt: Date.now() });
    return fresh;
  }

  /**
   * Persist (or bump sourceCount on) the patterns the LLM emitted.
   * Idempotent upsert keyed by lowercase pattern.
   */
  async record(
    companyId: string,
    pairs: Array<{ pattern: string; replacement: string }>,
  ): Promise<void> {
    if (pairs.length === 0) return;
    await this.surreal.withCompany(companyId, async (db) => {
      for (const { pattern, replacement } of pairs) {
        const lower = pattern.toLowerCase().trim();
        if (lower.length === 0) continue;
        const replaceTrim = replacement.trim();
        if (replaceTrim.length === 0) continue;
        try {
          await db.query(
            `UPSERT collapse_pattern
               SET pattern = $pattern,
                   replacement = $replacement,
                   sourceCount = (SELECT VALUE sourceCount FROM ONLY collapse_pattern
                                   WHERE pattern = $key LIMIT 1) ?? 0,
                   updatedAt = time::now(),
                   lastUsedAt = time::now()
               WHERE pattern = $key`,
            { key: lower, pattern: lower, replacement: replaceTrim },
          );
          // UPSERT WHERE with no match creates a fresh row; the
          // sourceCount subquery returns 0 there. Bump by 1 either way.
          await db.query(
            `UPDATE collapse_pattern SET sourceCount = sourceCount + 1, updatedAt = time::now() WHERE pattern = $key`,
            { key: lower },
          );
        } catch (e) {
          this.logger.warn(
            `record(${companyId}): failed to upsert collapse pattern "${lower}": ${(e as Error).message}`,
          );
        }
      }
    });
    this.invalidate(companyId);
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** Per-tenant snapshot size. Loads the snapshot if not cached so the
   *  caller (admin endpoint) gets a current figure rather than 0
   *  pre-bootstrap. Defensive: any backend error degrades to 0. */
  async poolSize(companyId: string): Promise<number> {
    try {
      const snap = await this.getSnapshot(companyId);
      return snap.patterns.size;
    } catch (e) {
      this.logger.debug(
        `collapse-pattern poolSize(${companyId}) → 0 on err: ${(e as Error).message ?? e}`,
      );
      return 0;
    }
  }

  private async loadFresh(companyId: string): Promise<CollapseSnapshot> {
    return this.surreal.withCompany(companyId, async (db) => {
      try {
        const [rows] = await db.query<
          [Array<{ pattern: string; replacement: string }>]
        >(`SELECT pattern, replacement FROM collapse_pattern`);
        const patterns = new Map<
          string,
          { pattern: string; replacement: string }
        >();
        for (const r of (rows as Array<{
          pattern: string;
          replacement: string;
        }>) ?? []) {
          if (
            typeof r.pattern === 'string' &&
            typeof r.replacement === 'string'
          ) {
            patterns.set(r.pattern.toLowerCase(), {
              pattern: r.pattern,
              replacement: r.replacement,
            });
          }
        }
        return { patterns };
      } catch (e) {
        this.logger.warn(
          `loadFresh(${companyId}) failed: ${(e as Error).message}; using empty snapshot`,
        );
        return { patterns: new Map() };
      }
    });
  }
}

/**
 * Scan the message for known collapse patterns and emit synthesised
 * collapse_state_change edits. Sub-millisecond at demo scale (≤200
 * patterns per tenant). Lexical-substring with word-boundary edges so
 * "switched" doesn't trip "witched" or any embedded substring.
 *
 * Overlap-free across matches: longer patterns matched first so
 * "moved from" wins over "moved" when both happen to be in the cache.
 * Per-match the routine claims the span; subsequent shorter matches
 * inside that span are skipped.
 */
export function extractCollapseEditsLocally(
  message: string,
  snapshot: CollapseSnapshot,
): Array<{
  pattern: string;
  replacement: string;
  span: { text: string; start: number; end: number };
}> {
  if (snapshot.patterns.size === 0 || message.length === 0) return [];
  const entries = [...snapshot.patterns.values()].sort(
    (a, b) => b.pattern.length - a.pattern.length,
  );
  const lower = message.toLowerCase();
  const out: Array<{
    pattern: string;
    replacement: string;
    span: { text: string; start: number; end: number };
  }> = [];
  const occupied: Array<[number, number]> = [];
  for (const { pattern, replacement } of entries) {
    const needle = pattern.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      const before = idx > 0 ? message[idx - 1]! : ' ';
      const after = end < message.length ? message[end]! : ' ';
      const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
      if (isWordChar(before) || isWordChar(after)) {
        from = end;
        continue;
      }
      const overlaps = occupied.some(
        ([s, e]) => !(end <= s || idx >= e),
      );
      if (!overlaps) {
        out.push({
          pattern,
          replacement,
          span: { text: message.slice(idx, end), start: idx, end },
        });
        occupied.push([idx, end]);
      }
      from = end;
    }
  }
  return out;
}
