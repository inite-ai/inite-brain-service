import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { retryOnUniqueViolation } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { detectLanguage } from '../ai/locale/language-detector';
import { KeyedMutex } from '../common/keyed-mutex';
import { ConflictConfig } from './conflict-resolver';
import { idTailOf, sourceTrustFor } from './ingest-utils';
import { FactEmbeddingService } from './fact-embedding.service';

/**
 * Per-fact write primitive: the single entry point for `fn::resolve_fact`
 * (migration 0039). Both ingest paths — typed ingestFact and mention-extracted
 * facts — route through `resolve()` so the 21-positional-arg invocation lives
 * in ONE place: a future signature change can't drift the call sites out of
 * sync (which would silently bind a value to the wrong slot, e.g. entropy into
 * script). Owns the conflict weights/thresholds (read from env), the
 * per-(company, entity, predicate) serialization lock, policy lookup, locale
 * detection, embedding, and the HyPE alt-embedding follow-up.
 */
@Injectable()
export class FactResolverService {
  private readonly logger = new Logger(FactResolverService.name);
  // Serializes concurrent fn::resolve_fact calls on the same
  // (company, entity, predicate) so at most one row ends up active —
  // SurrealDB 3.x no longer raises the OCC conflict the retry loop
  // relied on for this case. See KeyedMutex.
  private readonly resolveLock = new KeyedMutex();
  private readonly conflict: ConflictConfig;

  constructor(
    private readonly factEmbedding: FactEmbeddingService,
    private readonly predicateRegistry: PredicateRegistryService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.conflict = {
      similarityThreshold: this.cfgNum('CONFLICT_SIMILARITY_THRESHOLD', 0.85),
      weights: {
        confidence:  this.cfgNum('CONFLICT_WEIGHT_CONFIDENCE',  0.30),
        sourceTrust: this.cfgNum('CONFLICT_WEIGHT_SOURCE_TRUST', 0.40),
        recency:     this.cfgNum('CONFLICT_WEIGHT_RECENCY',     0.20),
        authority:   this.cfgNum('CONFLICT_WEIGHT_AUTHORITY',   0.10),
      },
      marginForSupersede: this.cfgNum('CONFLICT_MARGIN_SUPERSEDE',  0.15),
      rejectThreshold:    this.cfgNum('CONFLICT_REJECT_THRESHOLD', 0.30),
    };
  }

  /**
   * Resolve one fact end-to-end: read the predicate policy, embed (unless a
   * precomputed vector is supplied), run fn::resolve_fact, write the HyPE
   * alt-embedding, and — when `recordOutcomeMetric` is set (the direct typed
   * path) — bump the ingest-fact counter. Returns the raw resolver result plus
   * the resolved `semantics` so callers can shape IngestResult / trace.
   */
  async resolve(
    db: Surreal,
    p: {
      companyId: string;
      entityId: string;
      predicate: string;
      /** The string form stored in `object` and used for locale detection. */
      object: string;
      objectMeta?: object;
      /** Exact text to embed; defaults to `${predicate}: ${object}`. */
      embeddingText?: string;
      /** When supplied, skips the embed round-trip (batched mention path). */
      precomputedEmbedding?: number[];
      confidence: number;
      validFrom: Date;
      validUntil?: Date;
      source: unknown;
      entropy?: number;
      recordOutcomeMetric?: boolean;
    },
  ): Promise<{ result: any; semantics: string }> {
    // Read policy from the per-tenant registry. Pre-warm the snapshot so the
    // cache is populated before the synchronous policyFor() lookup. Defensive:
    // a registry bootstrap failure must not 500 the ingest — policyFor falls
    // back to the JS seed.
    try {
      await this.predicateRegistry.getSnapshot(p.companyId);
    } catch (e) {
      this.logger.warn(
        `ingest: predicate registry getSnapshot failed for ${p.companyId}: ${(e as Error).message}; using seed policy`,
      );
    }
    const policy = this.predicateRegistry.policyFor(p.companyId, p.predicate);
    const sourceTrust = sourceTrustFor(p.source as Parameters<typeof sourceTrustFor>[0]);

    // Locale rides into fn::resolve_fact as a param (migration 0039), a folded
    // INSERTED-only write rather than a follow-up UPDATE. detectLanguage is
    // pure TS; 'und' → leave the fields unset (NONE).
    const detLang = detectLanguage(p.object);
    const lang = detLang.language !== 'und' ? detLang.language : undefined;
    const script = detLang.language !== 'und' ? detLang.script : undefined;

    const embedding =
      p.precomputedEmbedding ??
      (await this.factEmbedding.embed(
        p.embeddingText ?? `${p.predicate}: ${p.object}`,
      ));

    const result = await this.resolveFactCall(db, {
      companyId: p.companyId,
      entityId: p.entityId,
      predicate: p.predicate,
      object: p.object,
      objectMeta: p.objectMeta,
      embedding,
      confidence: p.confidence,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      source: p.source,
      sourceTrust,
      semantics: policy.semantics,
      lang,
      script,
      entropy: p.entropy,
    });

    const factId = result?.factId ? String(result.factId) : null;
    const outcome = result?.outcome;

    // HyPE stays a post-call UPDATE: it's an LLM call, gated on isEnabled()
    // AND INSERTED, so pre-computing it would burn the model on
    // non-INSERTED outcomes.
    await this.factEmbedding.writeAltEmbeddingIfHype({
      db,
      factId,
      outcome,
      predicate: p.predicate,
      object: p.object,
    });

    if (p.recordOutcomeMetric && outcome) {
      this.metrics?.countIngestFact(String(outcome));
    }

    return { result, semantics: policy.semantics };
  }

  /**
   * The fn::resolve_fact invocation itself. `fn::resolve_fact` (migration
   * 0006) filters by cosine for bitemporal → scores → decides
   * INSERTED/SUPERSEDED/COMPETING/REJECTED → CREATE + cascade, all inside
   * SurrealDB's single-statement evaluation context (atomic without a
   * hand-rolled tx). Wrapped in retryOnUniqueViolation because the CREATE can
   * still hit a write-set conflict under FANOUT against the same
   * entity+predicate — retry sees the racing committer's row and
   * supersedes/competes on the second attempt.
   */
  private resolveFactCall(
    db: Surreal,
    p: {
      companyId: string;
      entityId: string;
      predicate: string;
      object: string;
      objectMeta?: object;
      embedding: number[];
      confidence: number;
      validFrom: Date;
      validUntil?: Date;
      source: unknown;
      sourceTrust: number;
      semantics: string;
      lang?: string;
      script?: string;
      entropy?: number;
    },
  ): Promise<any> {
    // Serialize resolves on the same (company, entity, predicate). Under
    // SurrealDB 3.x the OCC read-conflict that let racing single_active
    // resolves retry-and-supersede no longer fires for the function's
    // SELECT-then-write, so without this two concurrent ingests could
    // each leave an `active` row. NUL-joined (\x00) — no entity record tail
    // or predicate slug can contain a NUL, so the composite key can't
    // collide.
    const lockKey = `${p.companyId}\x00${p.entityId}\x00${p.predicate}`;
    return this.resolveLock.run(lockKey, () =>
      retryOnUniqueViolation(async () => {
        const [r] = await db.query<[any]>(
          `RETURN fn::resolve_fact(
            type::record('knowledge_entity', $eid),
            $predicate, $object, $object_meta, $embedding,
            $confidence, $valid_from, $valid_until, $source,
            $source_trust, $semantics, $similarity_threshold,
            $w_confidence, $w_source_trust, $w_recency, $w_authority,
            $reject_threshold, $margin_for_supersede,
            $lang, $script, $entropy
         )`,
          {
            eid: idTailOf(p.entityId),
            predicate: p.predicate,
            object: p.object,
            object_meta: p.objectMeta,
            embedding: p.embedding,
            confidence: p.confidence,
            valid_from: p.validFrom,
            valid_until: p.validUntil,
            source: p.source,
            source_trust: p.sourceTrust,
            semantics: p.semantics,
            similarity_threshold: this.conflict.similarityThreshold,
            w_confidence: this.conflict.weights.confidence,
            w_source_trust: this.conflict.weights.sourceTrust,
            w_recency: this.conflict.weights.recency,
            w_authority: this.conflict.weights.authority,
            reject_threshold: this.conflict.rejectThreshold,
            margin_for_supersede: this.conflict.marginForSupersede,
            lang: p.lang,
            script: p.script,
            entropy: p.entropy,
          },
        );
        return r;
      }),
    );
  }

  private cfgNum(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
}
