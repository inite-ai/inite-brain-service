import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbedderService } from '../ai/embedder.service';
import { ConflictConfig } from './conflict-resolver';
import { PriorRow } from './predictor-internals';
import { cosineSimilarity, vectorNorm } from '../common/vector-math';

/**
 * PredictScoringService — the slot gate behind the ingest preflight
 * (predict): the configured cosine thresholds and the candidate's
 * embedding. Since #830 (0177) write-time resolution has no weighted
 * score to mirror; which priors share the candidate's slot is the only
 * computed input, and IngestPredictionService applies the valid-time
 * rules over them. Split out so both classes stay ≤3 injected deps.
 */
@Injectable()
export class PredictScoringService {
  /** Exposed read-only so the orchestrator can name the gate it applied. */
  readonly conflict: ConflictConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly embedder: EmbedderService,
  ) {
    this.conflict = {
      similarityThreshold: this.cfgNum('CONFLICT_SIMILARITY_THRESHOLD', 0.85),
      slotSimilarityThreshold: this.cfgNum('DERIVER_SLOT_SIMILARITY', 0.9),
    };
  }

  /** Embed the candidate `predicate: object` for the slot gate. */
  async embedCandidate(predicate: string, object: string): Promise<number[]> {
    return this.embedder.embed(`${predicate}: ${object}`);
  }

  /** The priors that clear the cosine gate against the candidate (fn::resolve_fact's bitemporal slot). */
  sameSlot(candEmbedding: number[], priors: PriorRow[]): PriorRow[] {
    const norm = vectorNorm(candEmbedding);
    return priors.filter((p) => {
      const emb = Array.isArray(p.embedding) ? (p.embedding as number[]) : null;
      return (
        emb !== null &&
        emb.length === candEmbedding.length &&
        cosineSimilarity(candEmbedding, emb, norm) >= this.conflict.similarityThreshold
      );
    });
  }

  private cfgNum(key: string, fallback: number): number {
    const raw = this.configService.get<string | number | undefined>(key);
    if (raw === undefined || raw === null) return fallback;
    // Set-but-blank falls back — Number('') === 0 would zero the gate.
    if (typeof raw === 'string' && raw.trim() === '') return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
}
