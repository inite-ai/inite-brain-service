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
      /** Per-user scope (migration 0055); undefined = tenant-global. */
      userId?: string;
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
    const call = await this.buildResolveCall(p);
    const result = await this.resolveFactCall(db, call);
    await this.postResolve(db, p, result);
    return { result, semantics: call.semantics };
  }

  /**
   * Batched resolve for the mention path: N facts in as few round-trips as
   * possible. `append_only` facts (the bulk — preference/intent/interacted_with)
   * are pure INSERTs with no supersede and no active-row uniqueness, so they
   * carry NO cross-mention race and are collapsed into ONE multi-statement
   * `fn::resolve_fact` query with no lock. `single_active`/`bitemporal` facts
   * keep the per-fact + KeyedMutex path unchanged (their supersede logic needs
   * the cross-request serialization the batch can't provide). Results are
   * returned in input order. On a batch failure the append_only set falls back
   * to the per-fact path, so the outcome is identical either way.
   *
   * Gated by INGEST_BATCH_FACTS at the caller; when off, callers use `resolve()`
   * per fact and this is never reached.
   */
  async resolveMany(
    db: Surreal,
    inputs: Parameters<FactResolverService['resolve']>[1][],
  ): Promise<Array<{ result: any; semantics: string }>> {
    if (inputs.length === 0) return [];
    try {
      await this.predicateRegistry.getSnapshot(inputs[0].companyId);
    } catch (e) {
      this.logger.warn(
        `ingest: predicate registry getSnapshot failed for ${inputs[0].companyId}: ${(e as Error).message}; using seed policy`,
      );
    }

    const prepared = await Promise.all(
      inputs.map((p) => this.buildResolveCall(p)),
    );
    const results: any[] = new Array(inputs.length);
    const appendIdx: number[] = [];
    const restIdx: number[] = [];
    prepared.forEach((c, i) =>
      (c.semantics === 'append_only' ? appendIdx : restIdx).push(i),
    );

    if (appendIdx.length > 0) {
      try {
        const batch = await this.resolveAppendOnlyBatch(
          db,
          appendIdx.map((i) => prepared[i]),
        );
        appendIdx.forEach((i, k) => (results[i] = batch[k]));
      } catch (e) {
        this.logger.warn(
          `ingest: batched fact resolve fell back to per-fact: ${(e as Error).message}`,
        );
        for (const i of appendIdx) {
          results[i] = await this.resolveFactCall(db, prepared[i]);
        }
      }
    }
    // single_active / bitemporal keep the serialized per-fact path.
    for (const i of restIdx) {
      results[i] = await this.resolveFactCall(db, prepared[i]);
    }

    // Post-call side effects (HyPE + metric) per fact, in order.
    const out: Array<{ result: any; semantics: string }> = [];
    for (let i = 0; i < inputs.length; i++) {
      await this.postResolve(db, inputs[i], results[i]);
      out.push({ result: results[i], semantics: prepared[i].semantics });
    }
    return out;
  }

  /**
   * Shared pre-call preparation (policy, source trust, locale, embedding) that
   * turns a public resolve input into the positional `resolveFactCall` params.
   * One place so the per-fact and batched paths can never bind the wrong slot.
   */
  private async buildResolveCall(
    p: Parameters<FactResolverService['resolve']>[1],
  ): Promise<Parameters<FactResolverService['resolveFactCall']>[1]> {
    const policy = this.predicateRegistry.policyFor(p.companyId, p.predicate);
    const sourceTrust = sourceTrustFor(
      p.source as Parameters<typeof sourceTrustFor>[0],
    );
    const detLang = detectLanguage(p.object);
    const lang = detLang.language !== 'und' ? detLang.language : undefined;
    const script = detLang.language !== 'und' ? detLang.script : undefined;
    const embedding =
      p.precomputedEmbedding ??
      (await this.factEmbedding.embed(
        p.embeddingText ?? `${p.predicate}: ${p.object}`,
      ));
    return {
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
      userId: p.userId,
    };
  }

  /** HyPE alt-embedding follow-up + outcome metric — shared post-call tail. */
  private async postResolve(
    db: Surreal,
    p: Parameters<FactResolverService['resolve']>[1],
    result: any,
  ): Promise<void> {
    const factId = result?.factId ? String(result.factId) : null;
    const outcome = result?.outcome;
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
  }

  /**
   * Resolve a set of append_only facts in ONE round-trip via the stored
   * `fn::resolve_facts` (migration 0071), which maps `fn::resolve_fact` over the
   * array server-side and returns the results in order. Safe without the resolve
   * lock: append_only never supersedes and never asserts a unique active row, so
   * batched inserts are all correct.
   *
   * The 22-arg positional binding lives in the migration, NOT here — the TS side
   * passes a TYPED object array + one shared config, so a fn::resolve_fact
   * signature change can't silently drift a hand-built parameter string.
   * Optional fields are omitted when undefined so `$f.x` resolves to NONE
   * (matching the per-fact path), never NULL.
   */
  private async resolveAppendOnlyBatch(
    db: Surreal,
    prepared: Parameters<FactResolverService['resolveFactCall']>[1][],
  ): Promise<any[]> {
    const facts = prepared.map((c) => {
      const f: Record<string, unknown> = {
        eid: idTailOf(c.entityId),
        predicate: c.predicate,
        object: c.object,
        embedding: c.embedding,
        confidence: c.confidence,
        valid_from: c.validFrom,
        source: c.source,
        source_trust: c.sourceTrust,
        semantics: c.semantics,
      };
      // Omit-when-undefined: an absent object key reads as NONE server-side
      // (fn::resolve_fact's contract), whereas an explicit null would store
      // NULL — e.g. a NULL validUntil would break the `validUntil IS NONE`
      // active-fact read filter.
      if (c.objectMeta !== undefined) f.object_meta = c.objectMeta;
      if (c.validUntil !== undefined) f.valid_until = c.validUntil;
      if (c.lang !== undefined) f.lang = c.lang;
      if (c.script !== undefined) f.script = c.script;
      if (c.entropy !== undefined) f.entropy = c.entropy;
      if (c.userId !== undefined) f.user_id = c.userId;
      return f;
    });
    const cfg = {
      similarity_threshold: this.conflict.similarityThreshold,
      w_confidence: this.conflict.weights.confidence,
      w_source_trust: this.conflict.weights.sourceTrust,
      w_recency: this.conflict.weights.recency,
      w_authority: this.conflict.weights.authority,
      reject_threshold: this.conflict.rejectThreshold,
      margin_for_supersede: this.conflict.marginForSupersede,
    };
    const [rows] = await db.query<[any[]]>(
      `RETURN fn::resolve_facts($facts, $cfg)`,
      { facts, cfg },
    );
    return (rows as any[]) ?? [];
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
      userId?: string;
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
            $lang, $script, $entropy, $user_id
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
            user_id: p.userId,
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
