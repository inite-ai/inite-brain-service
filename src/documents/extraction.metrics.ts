import { Injectable, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

const DOCS = 'brain_extraction_read_documents_total';
const CHARS = 'brain_extraction_read_chars_total';
const DEPTH = 'brain_extraction_depth_documents_total';
const PROMOTED = 'brain_extraction_promoted_documents_total';

/**
 * What the background extraction read (extraction-batch.service.ts), on the
 * service's registry — the DecisionMetrics idiom: the subsystem owns its
 * instrumentation, /metrics stays one registry.
 *
 * Documents and characters by shape — a conversation read as one `group`,
 * or a document read `solo`. Beside brain_openai_tokens_total this is the
 * cost per ingested KB, and the group share is what grouping saves.
 */
@Injectable()
export class ExtractionMetrics {
  private readonly docs: Counter<'shape'> | undefined;
  private readonly chars: Counter<'shape'> | undefined;
  private readonly depths: Counter<'depth'> | undefined;
  private readonly promotions: Counter<'reason'> | undefined;

  constructor(@Optional() metrics?: MetricsService) {
    if (!metrics) return;
    const counter = (name: string, help: string): Counter<'shape'> =>
      (metrics.registry.getSingleMetric(name) as Counter<'shape'> | undefined) ??
      new Counter({ name, help, labelNames: ['shape'] as const, registers: [metrics.registry] });
    this.docs = counter(DOCS, 'Documents the background extraction read, by shape (group | solo)');
    this.chars = counter(
      CHARS,
      'Characters the background extraction read, by shape (group | solo)',
    );
    this.depths =
      (metrics.registry.getSingleMetric(DEPTH) as Counter<'depth'> | undefined) ??
      new Counter({
        name: DEPTH,
        help: 'Documents by the depth they were read at (raw | single | full) — the depth distribution',
        labelNames: ['depth'] as const,
        registers: [metrics.registry],
      });
    this.promotions =
      (metrics.registry.getSingleMetric(PROMOTED) as Counter<'reason'> | undefined) ??
      new Counter({
        name: PROMOTED,
        help: 'Reads something asked for (answer = an answer cited raw text; neighbour = beside an urgent read)',
        labelNames: ['reason'] as const,
        registers: [metrics.registry],
      });
  }

  depth(depth: 'raw' | 'single' | 'full', docs: number): void {
    this.depths?.inc({ depth }, docs);
  }

  promoted(reason: 'answer' | 'neighbour', docs: number): void {
    if (docs > 0) this.promotions?.inc({ reason }, docs);
  }

  read(shape: 'group' | 'solo', docs: number, chars: number): void {
    this.docs?.inc({ shape }, docs);
    this.chars?.inc({ shape }, chars);
  }
}
