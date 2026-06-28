import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import {
  ConflictConfig,
  SOURCE_TRUST,
  scoreFact,
} from './conflict-resolver';
import { sourceTrustFor } from './ingest-utils';

export type IngestOutcome =
  | 'INSERTED'
  | 'SUPERSEDED'
  | 'COMPETING'
  | 'REJECTED';

export interface PredictResolveArgs {
  entityRef:
    | { vertical: string; id: string }
    | { entityId: string };
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence?: number;
  source: {
    vertical: string;
    eventId?: string;
    messageId?: string;
    recorder?: string;
  };
}

export interface OpposingFact {
  factId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
}

export interface PredictResolveResult {
  wouldOutcome: IngestOutcome;
  reasoning: string;
  opposingFacts: OpposingFact[];
  predicatePolicy: {
    semantics: string;
    decayHalfLifeDays: number | null;
    piiClass: string;
  };
}

interface PriorRow {
  id: unknown;
  predicate: string;
  object: string;
  confidence?: number;
  validFrom: string | Date;
  validUntil?: string | Date | null;
  recordedAt: string | Date;
  embedding?: number[];
  source?: unknown;
  status?: string;
}

/**
 * IngestPredictionService — read-only dry-run of fn::resolve_fact.
 *
 * Answers "if I were to record this fact right now, what would the
 * resolver decide?" without writing to the database. The decision is
 * approximated in JS using the same scoring weights, recency decay,
 * and policy semantics the server-side function uses — the fidelity
 * gap vs. the live resolver is bounded by (a) source_trust learning
 * (we use the seed table, not the per-tenant learned rate from
 * migration 0022) and (b) embedding cache misses (we re-embed).
 *
 * Use as preflight from agent loops: "is the entity already
 * conflicted on this predicate?" or "would this fact be rejected
 * for being too unconfident under our weights?".
 *
 * No side effects: does NOT create the entity, does NOT bump
 * predicate-registry stats, does NOT touch source_trust.
 */
@Injectable()
export class IngestPredictionService {
  private readonly logger = new Logger(IngestPredictionService.name);
  private readonly conflict: ConflictConfig;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly predicateRegistry: PredicateRegistryService,
    private readonly configService: ConfigService,
  ) {
    this.conflict = {
      similarityThreshold: this.cfgNum('CONFLICT_SIMILARITY_THRESHOLD', 0.85),
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

  async predict(
    companyId: string,
    args: PredictResolveArgs,
  ): Promise<PredictResolveResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      const entityId = await this.lookupEntity(db, args.entityRef);
      if (!entityId) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            'No existing entity matches the ref; fact would be created against a new entity.',
          opposingFacts: [],
          predicatePolicy: this.predicateRegistry.policyFor(
            companyId,
            args.predicate,
          ),
        };
      }

      const candEmbedding = await this.embedder.embed(
        `${args.predicate}: ${args.object}`,
      );

      try {
        await this.predicateRegistry.getSnapshot(companyId);
      } catch (e) {
        this.logger.warn(
          `predictResolve: registry getSnapshot failed for ${companyId}: ${(e as Error).message}; using seed policy`,
        );
      }
      const policy = this.predicateRegistry.policyFor(
        companyId,
        args.predicate,
      );

      const validFrom = new Date(args.validFrom);
      const tail = entityId.startsWith('knowledge_entity:')
        ? entityId.slice('knowledge_entity:'.length)
        : entityId;
      const [rows] = await db.query<any[][]>(
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, embedding, source, status
           FROM knowledge_fact
           WHERE entityId = type::record('knowledge_entity', $eid)
             AND predicate = $predicate
             AND retractedAt IS NONE
             AND status = 'active'
           ORDER BY recordedAt DESC
           LIMIT 25`,
        { eid: tail, predicate: args.predicate },
      );
      const priors = ((rows as any[]) ?? []) as PriorRow[];

      const sourceTrust = sourceTrustFor(args.source);
      const candidateScore = scoreFact(
        {
          confidence: args.confidence ?? 0.7,
          sourceTrust,
          recordedAt: new Date(),
          authority: 0,
        },
        this.conflict,
      );

      if (candidateScore < this.conflict.rejectThreshold) {
        return {
          wouldOutcome: 'REJECTED',
          reasoning:
            `Candidate score ${candidateScore.toFixed(3)} is below the reject threshold ${this.conflict.rejectThreshold.toFixed(3)} — too unconfident or too low-trust to enter the graph.`,
          opposingFacts: priors.map(rowToOpposingFact),
          predicatePolicy: policy,
        };
      }

      if (policy.semantics === 'append_only') {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            'append_only predicate — multiple values coexist; no conflict possible at ingest.',
          opposingFacts: [],
          predicatePolicy: policy,
        };
      }

      const overlapping = priors.filter((p) =>
        intervalsOverlap({
          aFrom: new Date(p.validFrom),
          aUntil: p.validUntil ? new Date(p.validUntil) : null,
          bFrom: validFrom,
          bUntil: args.validUntil ? new Date(args.validUntil) : null,
        }),
      );

      if (overlapping.length === 0) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning: 'No existing fact overlaps the candidate validity interval.',
          opposingFacts: [],
          predicatePolicy: policy,
        };
      }

      if (policy.semantics === 'single_active') {
        return {
          ...this.predictSingleActive(candidateScore, overlapping),
          predicatePolicy: policy,
        };
      }

      // bitemporal
      const scored = this.scoreBitemporal(candEmbedding, overlapping);
      const above = scored.filter(
        (c) => c.cosine >= this.conflict.similarityThreshold,
      );
      if (above.length === 0) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            `Overlapping facts exist but none clear the cosine similarity threshold ${this.conflict.similarityThreshold.toFixed(2)}; semantically distinct, no contradiction.`,
          opposingFacts: scored.map((c) => c.opposing),
          predicatePolicy: policy,
        };
      }
      return {
        ...this.predictBitemporal(candidateScore, above),
        predicatePolicy: policy,
      };
    });
  }

  private async lookupEntity(
    db: Surreal,
    ref: PredictResolveArgs['entityRef'],
  ): Promise<string | null> {
    if ('entityId' in ref && ref.entityId) {
      const tail = ref.entityId.startsWith('knowledge_entity:')
        ? ref.entityId.slice('knowledge_entity:'.length)
        : ref.entityId;
      const [rows] = await db.query<any[][]>(
        `SELECT id FROM type::record('knowledge_entity', $tail) LIMIT 1`,
        { tail },
      );
      const row = (rows as any[])?.[0];
      return row ? String(row.id) : null;
    }
    const ext = ref as { vertical: string; id: string };
    const key = `${ext.vertical.replace(/\./g, '__')}__${ext.id.replace(/\./g, '__')}`;
    const [rows] = await db.query<[any[]]>(
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    const arr = (rows as any[]) ?? [];
    return arr[0] ? String(arr[0]) : null;
  }

  private predictSingleActive(
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
                ? sourceTrustFor(p.source as any)
                : SOURCE_TRUST.default,
            recordedAt: new Date(p.recordedAt),
            authority: 0,
          },
          this.conflict,
        ),
      }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
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

  private scoreBitemporal(
    candEmbedding: number[],
    overlapping: PriorRow[],
  ): Array<{ opposing: OpposingFact; cosine: number; score: number }> {
    const norm = vectorNorm(candEmbedding);
    return overlapping.map((p) => {
      const emb = Array.isArray(p.embedding) ? (p.embedding as number[]) : null;
      const cosine = emb ? cosineSimilarity(candEmbedding, emb, norm) : 0;
      const score = scoreFact(
        {
          confidence: p.confidence ?? 0.7,
          sourceTrust:
            typeof p.source === 'object' && p.source !== null
              ? sourceTrustFor(p.source as any)
              : SOURCE_TRUST.default,
          recordedAt: new Date(p.recordedAt),
          authority: 0,
        },
        this.conflict,
      );
      return { opposing: rowToOpposingFact(p), cosine, score };
    });
  }

  private predictBitemporal(
    candidateScore: number,
    above: Array<{ opposing: OpposingFact; cosine: number; score: number }>,
  ): Omit<PredictResolveResult, 'predicatePolicy'> {
    const top = above.reduce((acc, c) => (c.score > acc.score ? c : acc), above[0]);
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
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
}

function rowToOpposingFact(row: PriorRow): OpposingFact {
  return {
    factId: String(row.id),
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence ?? 0,
    validFrom: dateToIso(row.validFrom),
    validUntil: row.validUntil ? dateToIso(row.validUntil) : undefined,
    recordedAt: dateToIso(row.recordedAt),
  };
}

function dateToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
}

function intervalsOverlap({
  aFrom,
  aUntil,
  bFrom,
  bUntil,
}: {
  aFrom: Date;
  aUntil: Date | null;
  bFrom: Date;
  bUntil: Date | null;
}): boolean {
  const aEnd = aUntil ?? new Date(8.64e15);
  const bEnd = bUntil ?? new Date(8.64e15);
  return aFrom < bEnd && bFrom < aEnd;
}

function vectorNorm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosineSimilarity(a: number[], b: number[], aNorm: number): number {
  if (a.length !== b.length || aNorm === 0) return 0;
  let dot = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bNorm += b[i] * b[i];
  }
  bNorm = Math.sqrt(bNorm);
  if (bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}
