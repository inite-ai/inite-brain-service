import { Injectable, Logger } from '@nestjs/common';

/**
 * One fact in the source group fed to a SummaryGenerator. Sorted by
 * `validFrom` ascending by the caller, so generators can rely on
 * chronological order.
 */
export interface FactToSummarize {
  factId: string;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string | undefined;
  confidence: number;
}

/**
 * Pluggable summary generator. The default implementation is no-LLM —
 * it stitches the facts into a single chronological string. Verticals
 * that want richer summaries (LLM rollups) inject their own.
 */
export interface SummaryGenerator {
  generate(group: FactToSummarize[]): Promise<string>;
}

/**
 * No-LLM default — concat into a single time-ordered line per fact:
 *   `[2025-12-01] tier: gold | [2026-02-15] tier: platinum`.
 *
 * Cheap (no network), preserves traceability via `derivedFrom` (which
 * the CompactionService writes alongside this string), and gives the
 * search-time embedding something to work with. Verticals with high
 * compaction volume should swap in an LLM-backed generator that produces
 * a single sentence rather than a concat — but until then this is good
 * enough to ship.
 */
@Injectable()
export class ConcatSummaryGenerator implements SummaryGenerator {
  private readonly logger = new Logger(ConcatSummaryGenerator.name);

  async generate(group: FactToSummarize[]): Promise<string> {
    if (group.length === 0) return '';
    const parts = group.map((f) => {
      const day = f.validFrom.slice(0, 10);
      return `[${day}] ${f.predicate}: ${f.object}`;
    });
    const text = parts.join(' | ');
    // Cap at a reasonable length — the embedding model truncates anyway,
    // and very long summaries hurt downstream search relevance.
    const MAX = 8_000;
    if (text.length <= MAX) return text;
    this.logger.debug(
      `Summary truncated from ${text.length} to ${MAX} chars (${group.length} facts)`,
    );
    return text.slice(0, MAX - 3) + '...';
  }
}
