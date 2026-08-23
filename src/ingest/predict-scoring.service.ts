import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbedderService } from '../ai/embedder.service';
import { ConflictConfig, SOURCE_TRUST, scoreFact } from './conflict-resolver';
import { sourceTrustFor } from './ingest-utils';
import {
  OpposingFact,
  PredictResolveArgs,
  PredictResolveResult,
  PriorRow,
  cosineSimilarity,
  rowToOpposingFact,
  vectorNorm,
} from './predictor-internals';

/**
 * PredictScoringService — the conflict-scoring engine behind the ingest
 * preflight (predict). Owns the conflict weights/thresholds (built from
 * config), the candidate embedding, and the per-semantics scoring math
 * (single_active / bitemporal). IngestPredictionService gathers the DB
 * inputs and calls into here, reading `conflict` for the threshold
 * decisions. Splitting this out keeps both classes ≤3 injected deps.
 */
@Injectable()
export class PredictScoringService {
  /** Exposed read-only so the orchestrator can apply threshold gates. */
  readonly conflict: ConflictConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly embedder: EmbedderService,
  ) {
    this.conflict = {
      similarityThreshold: this.cfgNum('CONFLICT_SIMILARITY_THRESHOLD', 0.85),
      slotSimilarityThreshold: this.cfgNum('DERIVER_SLOT_SIMILARITY', 0.9),
      weights: {
        confidence: this.cfgNum('CONFLICT_WEIGHT_CONFIDENCE', 0.3),
        sourceTrust: this.cfgNum('CONFLICT_WEIGHT_SOURCE_TRUST', 0.4),
        recency: this.cfgNum('CONFLICT_WEIGHT_RECENCY', 0.2),
        authority: this.cfgNum('CONFLICT_WEIGHT_AUTHORITY', 0.1),
      },
      marginForSupersede: this.cfgNum('CONFLICT_MARGIN_SUPERSEDE', 0.15),
      rejectThreshold: this.cfgNum('CONFLICT_REJECT_THRESHOLD', 0.3),
    };
  }

  /** Embed the candidate `predicate: object` for similarity scoring. */
  async embedCandidate(predicate: string, object: string): Promise<number[]> {
    return this.embedder.embed(`${predicate}: ${object}`);
  }

  /** Score the candidate fact under the conflict weights. */
  scoreCandidate(args: PredictResolveArgs): number {
    return scoreFact(
      {
        confidence: args.confidence ?? 0.7,
        sourceTrust: sourceTrustFor(args.source),
        recordedAt: new Date(),
        authority: 0,
      },
      this.conflict,
    );
  }

  predictSingleActive(
    candidateScore: number,
    overlapping: PriorRow[],
  ): Omit<PredictResolveResult, 'predicatePolicy'> {
    const scored = overlapping
      .map((p) => ({
        opposing: rowToOpposingFact(p),
        score: scoreFact(
          {
            confidence: p.confidence ?? 0.7,
            sourceTrust:
              typeof p.source === 'object' && p.source !== null
                ? sourceTrustFor(p.source as Parameters<typeof sourceTrustFor>[0])
                : SOURCE_TRUST.default,
            recordedAt: new Date(p.recordedAt),
            authority: 0,
          },
          this.conflict,
        ),
      }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    // Caller guarantees a non-empty `overlapping` (competing.length === 0 is
    // short-circuited upstream), so `scored` is non-empty — fail loud if not.
    if (!top) throw new Error('predictSingleActive: no overlapping priors');
    const gap = candidateScore - top.score;
    if (gap > this.conflict.marginForSupersede) {
      return {
        wouldOutcome: 'SUPERSEDED',
        reasoning: `single_active predicate, candidate score ${candidateScore.toFixed(3)} beats strongest prior ${top.score.toFixed(3)} by ${gap.toFixed(3)} > margin ${this.conflict.marginForSupersede.toFixed(3)}; prior would be closed.`,
        opposingFacts: scored.map((s) => s.opposing),
      };
    }
    return {
      wouldOutcome: 'COMPETING',
      reasoning: `single_active predicate, candidate score ${candidateScore.toFixed(3)} vs strongest prior ${top.score.toFixed(3)} (gap ${gap.toFixed(3)}) within margin; both would remain active in COMPETING status.`,
      opposingFacts: scored.map((s) => s.opposing),
    };
  }

  scoreBitemporal(
    candEmbedding: number[],
    overlapping: PriorRow[],
  ): Array<{ opposing: OpposingFact; cosine: number; score: number; row: PriorRow }> {
    const norm = vectorNorm(candEmbedding);
    return overlapping.map((p) => {
      const emb = Array.isArray(p.embedding) ? (p.embedding as number[]) : null;
      const cosine = emb ? cosineSimilarity(candEmbedding, emb, norm) : 0;
      const score = scoreFact(
        {
          confidence: p.confidence ?? 0.7,
          sourceTrust:
            typeof p.source === 'object' && p.source !== null
              ? sourceTrustFor(p.source as Parameters<typeof sourceTrustFor>[0])
              : SOURCE_TRUST.default,
          recordedAt: new Date(p.recordedAt),
          authority: 0,
        },
        this.conflict,
      );
      return { opposing: rowToOpposingFact(p), cosine, score, row: p };
    });
  }

  predictBitemporal(
    candidateScore: number,
    above: Array<{ opposing: OpposingFact; cosine: number; score: number; row: PriorRow }>,
  ): Omit<PredictResolveResult, 'predicatePolicy'> {
    const first = above[0];
    // Caller guarantees a non-empty `above` (competing.length === 0 is
    // short-circuited upstream) — fail loud rather than reduce over nothing.
    if (!first) throw new Error('predictBitemporal: no priors above threshold');
    const top = above.reduce((acc, c) => (c.score > acc.score ? c : acc), first);
    const gap = candidateScore - top.score;
    if (gap > this.conflict.marginForSupersede) {
      return {
        wouldOutcome: 'SUPERSEDED',
        reasoning: `bitemporal predicate, strongest semantically-similar prior (cosine ${top.cosine.toFixed(2)}) score ${top.score.toFixed(3)}; candidate ${candidateScore.toFixed(3)} wins by ${gap.toFixed(3)} > margin ${this.conflict.marginForSupersede.toFixed(3)}.`,
        opposingFacts: above.map((c) => c.opposing),
      };
    }
    return {
      wouldOutcome: 'COMPETING',
      reasoning: `bitemporal predicate, strongest similar prior (cosine ${top.cosine.toFixed(2)}) score ${top.score.toFixed(3)} too close to candidate ${candidateScore.toFixed(3)} (gap ${gap.toFixed(3)}) within margin; both would remain active in COMPETING status.`,
      opposingFacts: above.map((c) => c.opposing),
    };
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
