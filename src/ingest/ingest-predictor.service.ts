import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
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
import { pinUserScope } from '../auth/user-scope';

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
    // Preflight sees the same per-user slice the eventual record_fact
    // would touch — pin the asserted userId to a user-bound token's
    // end-user (403 on mismatch). M2M credentials pass through.
    args = { ...args, userId: pinUserScope(args.userId) };
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
          predicatePolicy: this.predicateRegistry.policyFor(companyId, args.predicate),
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
      const policy = this.predicateRegistry.policyFor(companyId, args.predicate);
      const isBitemporal = policy.semantics === 'bitemporal';

      const candEmbedding = isBitemporal
        ? await this.scoring.embedCandidate(args.predicate, args.object)
        : null;

      const validFrom = new Date(args.validFrom);
      const tail = entityId.startsWith('knowledge_entity:')
        ? entityId.slice('knowledge_entity:'.length)
        : entityId;
      const priors = await queryRows<PriorRow>(
        db,
        `SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, ${isBitemporal ? 'embedding, ' : ''}source, status,
                userId, trustSnapshot, corroboration
           FROM knowledge_fact
           WHERE entityId = type::record('knowledge_entity', $eid)
             AND (predicateAlias ?? predicate) = $predicate
             AND retractedAt IS NONE
             AND status IN ['active', 'competing']
             AND ${args.userId ? '(userId IS NONE OR userId = $userId)' : 'userId IS NONE'}
           ORDER BY recordedAt DESC
           LIMIT ${PRIOR_SCAN_CAP}`,
        args.userId
          ? { eid: tail, predicate: args.predicate, userId: args.userId }
          : { eid: tail, predicate: args.predicate },
      );

      // The caller only sees an opposing fact it is allowed to read. The
      // priors themselves are untouched — the decision below runs on the
      // full set — so gating never changes wouldOutcome, only the list.
      const priorById = new Map(priors.map((p) => [String(p.id), p]));
      const gate = (list: OpposingFact[]): OpposingFact[] =>
        list.filter((o) =>
          rowFilter.filter((priorById.get(o.factId) as never) ?? { predicate: o.predicate }),
        );

      // The decision below mirrors fn::resolve_fact's ORDER (0177):
      // append_only → the slot (single_active: overlapping priors;
      // bitemporal: overlapping priors that clear the cosine gate) →
      // empty slot INSERTED → CORROBORATED (another origin, then the same
      // origin restating) → INSERTED_HISTORICAL (a value of the slot starts
      // later) → SUPERSEDED (values that started earlier end here) →
      // INSERTED for fact resolution (same valid time, another value).
      // Getting the order wrong makes the preflight report an outcome the
      // real resolver would never pick.
      const incomingOrigin = originKeyOf(args.source);

      if (policy.semantics === 'append_only') {
        const appendCorroborator = priors.find(
          (c) => c.object === args.object && originKeyOf(c.source) !== incomingOrigin,
        );
        if (appendCorroborator) {
          return {
            wouldOutcome: 'CORROBORATED',
            reasoning: `Same object already recorded from a different origin (${originKeyOf(appendCorroborator.source)} ≠ ${incomingOrigin}); the fact would corroborate the incumbent, not duplicate it (0082: corroboration runs for append_only).`,
            opposingFacts: gate([rowToOpposingFact(appendCorroborator)]),
            predicatePolicy: policy,
          };
        }
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
      const slot =
        policy.semantics === 'single_active'
          ? overlapping
          : this.scoring.sameSlot(candEmbedding!, overlapping);

      if (slot.length === 0) {
        return {
          wouldOutcome: 'INSERTED',
          reasoning:
            policy.semantics === 'single_active'
              ? 'No open value of this predicate overlaps the candidate; it would be inserted.'
              : `No open value overlaps the candidate and clears the cosine gate ${this.scoring.conflict.similarityThreshold.toFixed(2)}; semantically distinct, no conflict.`,
          opposingFacts: [],
          predicatePolicy: policy,
        };
      }

      const corroborator =
        slot.find((c) => c.object === args.object && originKeyOf(c.source) !== incomingOrigin) ??
        slot.find((c) => c.object === args.object);
      if (corroborator) {
        return {
          wouldOutcome: 'CORROBORATED',
          reasoning:
            originKeyOf(corroborator.source) !== incomingOrigin
              ? `Same object already recorded from a different origin; the fact would corroborate the incumbent.`
              : `Same object already recorded from the same origin; the fact would be kept as a restatement of it.`,
          opposingFacts: gate([rowToOpposingFact(corroborator)]),
          predicatePolicy: policy,
        };
      }

      const at = (v: string | Date) => new Date(v).getTime();
      const later = slot
        .filter((c) => at(c.validFrom) > validFrom.getTime())
        .sort((a, b) => at(a.validFrom) - at(b.validFrom));
      if (later.length > 0) {
        return {
          wouldOutcome: 'INSERTED_HISTORICAL',
          reasoning: `A value of this slot starts later (validFrom ${dateToIso(later[0]!.validFrom)}); the candidate would be inserted as history it replaced.`,
          opposingFacts: gate(later.map(rowToOpposingFact)),
          predicatePolicy: policy,
        };
      }

      const earlier =
        policy.semantics === 'single_active'
          ? slot
          : slot.filter((c) => at(c.validFrom) < validFrom.getTime());
      if (earlier.length > 0) {
        return {
          wouldOutcome: 'SUPERSEDED',
          reasoning: `The candidate starts after ${earlier.length === 1 ? 'the value' : `${earlier.length} values`} it overlaps on this slot; ${earlier.length === 1 ? 'it' : 'they'} would end at its validFrom.`,
          opposingFacts: gate(earlier.map(rowToOpposingFact)),
          predicatePolicy: policy,
        };
      }

      return {
        wouldOutcome: 'INSERTED',
        reasoning:
          'Another value of this slot holds from the same moment; the fact would be inserted and fact resolution would judge the pair (a paraphrase corroborates, a replacement supersedes, a disagreement competes).',
        opposingFacts: gate(slot.map(rowToOpposingFact)),
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
      const row = await queryFirst<{ id: unknown }>(
        db,
        `SELECT id FROM type::record('knowledge_entity', $tail) LIMIT 1`,
        { tail },
      );
      return row ? String(row.id) : null;
    }
    const ext = ref as { vertical: string; id: string };
    const key = `${ext.vertical.replace(/\./g, '__')}__${ext.id.replace(/\./g, '__')}`;
    const arr = await queryRows<unknown>(
      db,
      `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key },
    );
    return arr[0] ? String(arr[0]) : null;
  }
}
