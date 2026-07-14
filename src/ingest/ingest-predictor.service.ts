import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { PredictScoringService } from './predict-scoring.service';
import {
  OpposingFact,
  PredictResolveArgs,
  PredictResolveResult,
  PriorRow,
  dateToIso,
  intervalsOverlap,
  originKeyOf,
  rowToOpposingFact,
} from './predictor-internals';
import { makeRowPolicyFilter } from '../policy/row-filter';

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
 * and policy semantics (INSERTED / INSERTED_HISTORICAL / CORROBORATED /
 * SUPERSEDED / COMPETING / REJECTED, in the resolver's order) the
 * server-side function uses. The fidelity gap vs. the live resolver is
 * bounded by: (a) source_trust learning (we use the seed table, not the
 * per-tenant learned rate from migration 0022); (b) embedding cache
 * misses (we re-embed); (c) declared source authority (we score it as
 * the neutral 0, so a high-authority source's margin is understated);
 * and (d) the prior scan cap below — the resolver scans every active
 * competitor, the preflight the most recent PRIOR_SCAN_CAP.
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
/**
 * How many recent active competitors the preflight scans. The live
 * resolver scans every active competitor; this caps the advisory path's
 * cost. Newest-first, so the strongest recency-weighted opponents are
 * always in-window — a miss only occurs past this many co-active facts
 * on one (entity, predicate), rare outside bitemporal firehoses.
 */
const PRIOR_SCAN_CAP = 100;

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
    callerScopes: readonly string[],
  ): Promise<PredictResolveResult> {
    // opposingFacts carry raw `object` values, so the preflight must run
    // the same app-layer gate as every read surface. The DB-level PII
    // fence (migration 0005) is inert for the system-user pool (verified
    // in test/abac-db-fence.e2e-spec.ts), so the JS filter (requiresScope
    // PII gate + ABAC row rules) is the only working gate. It gates the
    // returned opposingFacts only — the priors still drive the decision,
    // so wouldOutcome is unchanged by what the caller may or may not see.
    return this.surreal.withScopedCompany(companyId, callerScopes, (db) =>
      this.predictScoped({ db, companyId, args, callerScopes }),
    );
  }

  private async predictScoped(opts: {
    db: Surreal;
    companyId: string;
    args: PredictResolveArgs;
    callerScopes: readonly string[];
  }): Promise<PredictResolveResult> {
    const { db, companyId, args, callerScopes } = opts;
    const rowFilter = makeRowPolicyFilter({
      callerScopes,
      surface: 'detect_contradiction',
      policyLookup: await this.predicateRegistry.rowPolicyLookup(companyId),
    });
    try {
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

      // Policy FIRST: the candidate embedding (an OpenAI call) and the
      // priors' embedding vectors (~1.2 MB of JSON at the 100-row cap)
      // are only consumed by the bitemporal cosine branch. Resolving the
      // policy up front lets append_only/single_active skip both — the
      // embed call was pure waste on those semantics.
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
      const isBitemporal = policy.semantics === 'bitemporal';

      const candEmbedding = isBitemporal
        ? await this.scoring.embedCandidate(args.predicate, args.object)
        : null;

      const validFrom = new Date(args.validFrom);
      const tail = entityId.startsWith('knowledge_entity:')
        ? entityId.slice('knowledge_entity:'.length)
        : entityId;
      const [rows] = await db.query<any[][]>(
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, ${isBitemporal ? 'embedding, ' : ''}source, status,
                userId, trustSnapshot, corroboration
           FROM knowledge_fact
           WHERE entityId = type::record('knowledge_entity', $eid)
             AND predicate = $predicate
             AND retractedAt IS NONE
             AND status = 'active'
             AND ${args.userId ? '(userId IS NONE OR userId = $userId)' : 'userId IS NONE'}
           ORDER BY recordedAt DESC
           LIMIT ${PRIOR_SCAN_CAP}`,
        args.userId
          ? { eid: tail, predicate: args.predicate, userId: args.userId }
          : { eid: tail, predicate: args.predicate },
      );
      const priors = ((rows as any[]) ?? []) as PriorRow[];

      // The caller only sees an opposing fact it is allowed to read. The
      // priors themselves are untouched — the decision below runs on the
      // full set — so gating never changes wouldOutcome, only the list.
      const priorById = new Map(priors.map((p) => [String(p.id), p]));
      const gate = (list: OpposingFact[]): OpposingFact[] =>
        list.filter((o) =>
          rowFilter.filter(
            (priorById.get(o.factId) as never) ?? { predicate: o.predicate },
          ),
        );

      const candidateScore = this.scoring.scoreCandidate(args);

      // The decision below mirrors fn::resolve_fact's ORDER (migration
      // 0055): reject (bitemporal only) → empty-competing INSERTED →
      // CORROBORATED → INSERTED_HISTORICAL (single_active) → supersede/
      // compete. Getting the order OR the semantics wrong makes the
      // preflight report an outcome the real resolver would never pick.

      // 1. Reject is bitemporal-ONLY. single_active/append_only never
      // reject on a low score — they insert/supersede/append (0055:69
      // guards the reject with `$semantics = 'bitemporal'`).
      if (
        policy.semantics === 'bitemporal' &&
        candidateScore < this.scoring.conflict.rejectThreshold
      ) {
        return {
          wouldOutcome: 'REJECTED',
          reasoning:
            `bitemporal predicate, candidate score ${candidateScore.toFixed(3)} is below the reject threshold ${this.scoring.conflict.rejectThreshold.toFixed(3)} — too unconfident or too low-trust to enter the graph.`,
          opposingFacts: gate(priors.map(rowToOpposingFact)),
          predicatePolicy: policy,
        };
      }

      // 2. append_only never has competing facts — always INSERTED.
      if (policy.semantics === 'append_only') {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            'append_only predicate — multiple values coexist; no conflict possible at ingest.',
          opposingFacts: [],
          predicatePolicy: policy,
        };
      }

      // 3. Build the competing set the way the stored fn does: for
      // single_active it is ALL active priors; for bitemporal it is the
      // interval-overlapping priors that also clear the cosine threshold.
      let competing: PriorRow[];
      let bitemporalAbove:
        | ReturnType<PredictScoringService['scoreBitemporal']>
        | undefined;
      if (policy.semantics === 'single_active') {
        competing = priors;
      } else {
        const overlapping = priors.filter((p) =>
          intervalsOverlap({
            aFrom: new Date(p.validFrom),
            aUntil: p.validUntil ? new Date(p.validUntil) : null,
            bFrom: validFrom,
            bUntil: args.validUntil ? new Date(args.validUntil) : null,
          }),
        );
        bitemporalAbove = this.scoring
          .scoreBitemporal(candEmbedding!, overlapping)
          .filter((c) => c.cosine >= this.scoring.conflict.similarityThreshold);
        competing = bitemporalAbove.map((c) => c.row);
      }

      // 4. No competitor → clean insert.
      if (competing.length === 0) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            policy.semantics === 'single_active'
              ? 'No existing active fact on this predicate; fact would be inserted.'
              : `Overlapping facts exist but none clear the cosine similarity threshold ${this.scoring.conflict.similarityThreshold.toFixed(2)}; semantically distinct, no contradiction.`,
          opposingFacts: [],
          predicatePolicy: policy,
        };
      }

      // 5. Corroboration: the SAME object from a DIFFERENT origin is
      // independent confirmation, not a conflict (0055:147, keyed on
      // origin_key_of, and it runs BEFORE the backdated guard). The new
      // row is kept as `corroborating`; nothing is superseded.
      const incomingOrigin = originKeyOf(args.source);
      const corroborator = competing.find(
        (c) => c.object === args.object && originKeyOf(c.source) !== incomingOrigin,
      );
      if (corroborator) {
        return {
          wouldOutcome: 'CORROBORATED',
          reasoning: `Same object already recorded from a different origin (${originKeyOf(corroborator.source)} ≠ ${incomingOrigin}); the fact would corroborate the incumbent, not conflict.`,
          opposingFacts: gate([rowToOpposingFact(corroborator)]),
          predicatePolicy: policy,
        };
      }

      // 6. Backdated guard (single_active only): a competitor with a
      // STRICTLY NEWER validFrom means the incoming fact is history — it
      // slots in already-superseded, the active timeline is untouched
      // (0055:190).
      if (policy.semantics === 'single_active') {
        const newer = competing
          .filter((c) => new Date(c.validFrom) > validFrom)
          .sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime());
        if (newer.length > 0) {
          return {
            wouldOutcome: 'INSERTED_HISTORICAL',
            reasoning: `A newer fact (validFrom ${dateToIso(newer[0].validFrom)}) already exists; the backdated candidate would be inserted as already-superseded history, not supersede the active fact.`,
            opposingFacts: gate(newer.map(rowToOpposingFact)),
            predicatePolicy: policy,
          };
        }
      }

      // 7. Supersede vs compete on the conflict score.
      if (policy.semantics === 'single_active') {
        const r = this.scoring.predictSingleActive(candidateScore, competing);
        return {
          ...r,
          opposingFacts: gate(r.opposingFacts),
          predicatePolicy: policy,
        };
      }
      const r = this.scoring.predictBitemporal(candidateScore, bitemporalAbove!);
      return {
        ...r,
        opposingFacts: gate(r.opposingFacts),
        predicatePolicy: policy,
      };
    } finally {
      rowFilter.finish();
    }
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
