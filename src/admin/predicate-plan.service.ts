import { Injectable, Logger } from '@nestjs/common';
import {
  PredicateRegistryService,
  type PredicateSnapshot,
} from '../ai/predicate-registry.service';
import { EmbedderService } from '../ai/embedder.service';
import { traceArtifact } from '../common/debug-trace';
import { extractPredicateHintsLocally } from './chat-router-internals/local-prepass';

/**
 * Predicate-planning slice of the chat-router local pre-pass: load the
 * per-tenant predicate snapshot and compute embedding-based predicate hints for
 * the message. Grouped because both lean on the predicate registry / embedder,
 * keeping the planner at ≤3 deps. Hint thresholds read from env.
 */
@Injectable()
export class PredicatePlanService {
  private readonly logger = new Logger(PredicatePlanService.name);
  private readonly hintSimilarityThreshold = cfgFloat(
    'CHAT_ROUTE_HINT_SIMILARITY',
    0.4,
  );
  private readonly hintMaxCount = cfgInt('CHAT_ROUTE_HINT_MAX', 3);

  constructor(
    private readonly registry: PredicateRegistryService,
    private readonly embedder: EmbedderService,
  ) {}

  async plan(
    message: string,
    companyId: string,
  ): Promise<{
    snapshot: PredicateSnapshot | null;
    predicateVocab: string[];
    localHints: Awaited<ReturnType<typeof extractPredicateHintsLocally>>;
  }> {
    const snapshot = await this.loadPredicateSnapshot(companyId);
    const predicateVocab = snapshot?.active.map((p) => p.predicateId) ?? [];

    const localHints = await extractPredicateHintsLocally({
      message,
      snapshot,
      embedder: this.embedder,
      threshold: this.hintSimilarityThreshold,
      maxHints: this.hintMaxCount,
    });
    traceArtifact('demo.chat.local_hints', {
      hints: localHints,
      threshold: this.hintSimilarityThreshold,
      poolSize: snapshot?.embeddings.size ?? 0,
    });

    return { snapshot, predicateVocab, localHints };
  }

  private async loadPredicateSnapshot(
    companyId: string,
  ): Promise<PredicateSnapshot | null> {
    try {
      return await this.registry.getSnapshot(companyId);
    } catch (e) {
      this.logger.warn(
        `chat router: registry getSnapshot failed for ${companyId}: ${(e as Error).message}; falling back to permissive vocab`,
      );
      return null;
    }
  }
}

function cfgFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function cfgInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
