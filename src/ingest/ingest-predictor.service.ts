import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { PredictScoringService } from './predict-scoring.service';
import {
  PredictResolveArgs,
  PredictResolveResult,
  PriorRow,
  intervalsOverlap,
  rowToOpposingFact,
} from './predictor-internals';

export type {
  IngestOutcome,
  PredictResolveArgs,
  PredictResolveResult,
  OpposingFact,
} from './predictor-internals';

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
 *
 * This class is the orchestration half — it gathers the DB/embedder/
 * registry inputs and delegates the conflict-scoring decisions to
 * PredictScoringService.
 */
@Injectable()
export class IngestPredictionService {
  private readonly logger = new Logger(IngestPredictionService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly predicateRegistry: PredicateRegistryService,
    private readonly scoring: PredictScoringService,
  ) {}

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

      const candEmbedding = await this.scoring.embedCandidate(
        args.predicate,
        args.object,
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

      const candidateScore = this.scoring.scoreCandidate(args);

      if (candidateScore < this.scoring.conflict.rejectThreshold) {
        return {
          wouldOutcome: 'REJECTED',
          reasoning:
            `Candidate score ${candidateScore.toFixed(3)} is below the reject threshold ${this.scoring.conflict.rejectThreshold.toFixed(3)} — too unconfident or too low-trust to enter the graph.`,
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
          ...this.scoring.predictSingleActive(candidateScore, overlapping),
          predicatePolicy: policy,
        };
      }

      // bitemporal
      const scored = this.scoring.scoreBitemporal(candEmbedding, overlapping);
      const above = scored.filter(
        (c) => c.cosine >= this.scoring.conflict.similarityThreshold,
      );
      if (above.length === 0) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            `Overlapping facts exist but none clear the cosine similarity threshold ${this.scoring.conflict.similarityThreshold.toFixed(2)}; semantically distinct, no contradiction.`,
          opposingFacts: scored.map((c) => c.opposing),
          predicatePolicy: policy,
        };
      }
      return {
        ...this.scoring.predictBitemporal(candidateScore, above),
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
}
