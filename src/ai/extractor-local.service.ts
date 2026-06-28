import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { LocalNerService } from './local-ner.service';
import { ExtractionPatternService } from './extraction-pattern.service';
import { splitClauses } from './clause-splitter';
import { attemptLocalSynth } from './extractor-internals/local-synth';
import { persistExtractionPatterns } from './extractor-internals/pattern-emitter';
import type {
  ExtractedEdge,
  ExtractedFact,
  ExtractionResult,
} from './extractor-internals/types';

/**
 * ExtractorLocalService — the no-LLM slice of the extractor: the
 * skip-LLM local fast path (clause split + local NER + cached-pattern
 * synthesis) and the post-assembly pattern emission. Owns localNer +
 * extractionPatterns. The skip gate is read from the environment so this
 * stays at ≤2 deps. trySkip returns the result (or null); caching is the
 * orchestrator's job.
 */
@Injectable()
export class ExtractorLocalService {
  private readonly logger = new Logger(ExtractorLocalService.name);

  constructor(
    private readonly localNer: LocalNerService,
    private readonly extractionPatterns: ExtractionPatternService,
  ) {}

  /**
   * Attempt a fully-local extraction (no LLM). Returns the synthesised
   * result when every clause is covered by cached patterns + local NER,
   * else null so the caller falls through to the LLM path.
   */
  async trySkip(
    companyId: string,
    trimmed: string,
  ): Promise<ExtractionResult | null> {
    const localClauses = splitClauses(trimmed);
    traceArtifact('extractor.local_clauses', {
      count: localClauses.length,
      clauses: localClauses,
    });
    let localEntities: Awaited<ReturnType<LocalNerService['extract']>> = [];
    if (this.localNer.isReady()) {
      localEntities = await this.localNer.extract(trimmed);
      if (localEntities.length > 0) {
        traceArtifact('extractor.local_entities', {
          count: localEntities.length,
          entities: localEntities,
        });
      }
    }
    const skipEnabled =
      (process.env.EXTRACTOR_SKIP_LLM_ENABLED ?? 'false') === 'true';
    if (!skipEnabled) return null;
    if (localClauses.length === 0) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'no_local_clauses',
      });
      return null;
    }
    if (localEntities.length === 0) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'no_local_entities',
      });
      return null;
    }
    const synthesised = await attemptLocalSynth({
      patterns: this.extractionPatterns,
      companyId,
      inputText: trimmed,
      clauseTexts: localClauses.map((c) => c.text),
      localEntities,
    });
    if (!synthesised) {
      traceArtifact('extractor.skip_decision', {
        skip: false,
        reason: 'partial_coverage',
      });
      return null;
    }
    traceArtifact('extractor.skip_decision', { skip: true, reason: 'all_local' });
    return synthesised;
  }

  /** Best-effort pattern emission after an LLM assembly. Fire-and-forget. */
  persistPatterns(args: {
    companyId: string;
    clauses: unknown[];
    rawFacts: unknown[];
    facts: ExtractedFact[];
    edges: ExtractedEdge[];
  }): void {
    void persistExtractionPatterns({
      patterns: this.extractionPatterns,
      logger: this.logger,
      companyId: args.companyId,
      clauses: args.clauses as never,
      rawFacts: args.rawFacts as never,
      facts: args.facts,
      edges: args.edges,
    });
  }
}
