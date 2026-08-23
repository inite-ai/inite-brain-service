import { Injectable, Logger } from '@nestjs/common';
import { traceArtifact } from '../common/debug-trace';
import { resolveExtractionProfile } from './extraction-profile';
import { PredicateRegistryService, PredicateSnapshot } from './predicate-registry.service';
import { LocalPredicateSelectorService } from './local-predicate-selector.service';
import type { ExtractedFact } from './extractor-internals/types';
import {
  applyAliasPass,
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
    // Dialogue profile (Phase 4): the point is to KEEP the specific predicate
    // the extractor coined (painted, researched, relationship_status) rather
    // than snap it back to a generic catch-all. Both OVERWRITING refinement
    // passes (local-override 0.45, canonicalize 0.85) collapse specificity,
    // so they stay off — but the prompt's promised EDC canonicalization now
    // runs as the ALIAS pass (0082, audit finding #2): the coinage survives
    // in `predicate`, the canonical id lands in `predicateAlias`, and
    // dedup/corroboration/read-side consumers key on `alias ?? predicate`.
    const profile = resolveExtractionProfile();
    if (profile.vocabulary === 'open') {
      if (facts.length === 0) return;
      try {
        const aliasDecisions = await applyAliasPass({
          facts,
          registry: this.registry,
          companyId,
          logger: this.logger,
        });
        if (aliasDecisions.length > 0) {
          traceArtifact('extractor.predicate_alias', aliasDecisions);
        }
      } catch (e) {
        this.logger.warn(
          `extractor: alias pass failed: ${(e as Error).message}; facts keep raw coined predicates`,
        );
      }
      return;
    }
    const localThreshold = profile.refinePredicateThreshold;
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
