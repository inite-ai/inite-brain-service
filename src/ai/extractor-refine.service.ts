import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import {
  PredicateRegistryService,
  PredicateSnapshot,
} from './predicate-registry.service';
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import type { ExtractedFact } from './extractor-internals/types';
import {
  applyCanonicalizePass,
  applyLocalPredicateOverrides,
} from './extractor-internals/predicate-canonicalize';

/**
 * ExtractorRefineService — post-extraction predicate refinement: the
 * local-predicate-selector overrides and the EDC canonicalize pass
 * against the registry. Owns registry + localPredicates; the threshold
 * is read from the environment so this stays at ≤2 deps.
 */
@Injectable()
export class ExtractorRefineService {
  private readonly logger = new Logger(ExtractorRefineService.name);

  constructor(
    private readonly registry: PredicateRegistryService,
    private readonly localPredicates: LocalPredicateSelectorService,
  ) {}

  async applyPredicateRefinements(
    facts: ExtractedFact[],
    snapshot: PredicateSnapshot,
    companyId: string,
  ): Promise<void> {
    const localThreshold = parseFloat(
      process.env.EXTRACTOR_LOCAL_PREDICATE_THRESHOLD ?? '0.45',
    );
    const localOverrides = await applyLocalPredicateOverrides({
      facts,
      snapshot,
      selector: this.localPredicates,
      threshold: localThreshold,
    });
    if (localOverrides.length > 0) {
      traceArtifact('extractor.local_predicate_override', {
        threshold: localThreshold,
        decisions: localOverrides,
      });
    }
    try {
      if (facts.length === 0) return;
      const decisions = await applyCanonicalizePass({
        facts,
        registry: this.registry,
        companyId,
        logger: this.logger,
      });
      if (decisions.length > 0) {
        traceArtifact('extractor.canonicalize', decisions);
      }
    } catch (e) {
      this.logger.warn(
        `extractor: canonicalize pass failed: ${(e as Error).message}; keeping model-emitted predicates`,
      );
    }
  }
}
