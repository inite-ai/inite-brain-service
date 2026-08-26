import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import { queryRows, retryOnUniqueViolation } from '../db/surreal.service';
import { scopeForUser } from '../auth/scope-tags';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { detectLanguage } from '../ai/locale/language-detector';
import { envFlagEnabled } from '../common/env-validation';
import { KeyedMutex } from '../common/keyed-mutex';
import { ConflictConfig, type DerivedSemantics, type ResolveOutcome } from './conflict-resolver';
import { idTailOf, sourceTrustFor } from './ingest-utils';
import { stampGroundingStatus } from './grounding-stamp';
import { FactEmbeddingService } from './fact-embedding.service';
import { MemoryOutcomeService, type OutcomeEventInput } from '../outcomes/memory-outcome.service';

/**
 * V9 §1 — aspect classes for the derived-world lifecycle. The deriver's
 * aspect IS the predicate (closed 16-slug vocabulary). Value-bearing
 * aspects hold a CURRENT value that knowledge updates replace ("lives
 * in X", "works at Y"); event-like aspects accumulate history. NOTE:
 * these are topic CLASSES, not slots — the bitemporal_event similarity
 * gate (0083) is what keeps unrelated claims of one class from
 * competing; this set only decides which class gets a lifecycle at all.
 */
export const VALUE_BEARING_ASPECTS: ReadonlySet<string> = new Set([
  'identity',
  'residence',
  'work',
  'education',
  'health',
  'possessions',
  'preferences',
]);

/** Derive-internal semantics choice (V9 §1); pure, exported for tests. */
export function derivedSemanticsFor(aspect: string, slotSemantics: boolean): DerivedSemantics {
  return slotSemantics && VALUE_BEARING_ASPECTS.has(aspect) ? 'bitemporal_event' : 'append_only';
}

/**
 * Confidence-aware language-attribution metadata (multilingual Tier 1,
 * migration 0100). Built ONLY when MULTILINGUAL_LANG_ATTRIBUTION is on and
 * stamped onto the created fact by a follow-up UPDATE (the stampFactScope
 * idiom) — kept OUT of fn::resolve_fact so the resolver signature and its
 * pinned invariants are untouched. Undefined ⇒ no stamp ⇒ byte-identical.
 */
interface LangAttributionMeta {
  langConfidence: number;
  langSource: 'detected' | 'inherited' | 'explicit';
  detectorVersion: string;
  /** Language of the SOURCE turn (distinct from the object's `lang`). */
  sourceLang?: string | undefined;
}

/**
 * Per-fact write primitive: the single entry point for `fn::resolve_fact`
 * (migration 0039). Both ingest paths — typed ingestFact and mention-extracted
 * facts — route through `resolve()` so the 25-positional-arg invocation
 * (as of 0084: …, $predicate_alias, $slot_similarity) lives
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

  // Fourth dep is the optional 0107 outcome-telemetry writer; @Optional
  // so positionally-constructed unit tests stay three-argument.
  // eslint-disable-next-line max-params
  constructor(
    private readonly factEmbedding: FactEmbeddingService,
    private readonly predicateRegistry: PredicateRegistryService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly outcomes?: MemoryOutcomeService,
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
      /**
       * EDC-canonical id when `predicate` is a coined (open-vocabulary)
       * form (0082). Resolution keys on `predicateAlias ?? predicate`,
       * so coinages of one canon dedup/corroborate. Omit when the
       * predicate is already canonical.
       */
      predicateAlias?: string | undefined;
      /** The string form stored in `object` and used for locale detection. */
      object: string;
      /**
       * Language (ISO 639-1) of the SOURCE message/turn this fact was
       * extracted from, when the caller knows it. Under
       * MULTILINGUAL_LANG_ATTRIBUTION it is (a) stamped as `sourceLang`
       * (distinct from the object's own `lang`) and (b) inherited onto a
       * short / stopword-less object whose own language can't be detected
       * (recorded as langSource='inherited'). Absent ⇒ no inheritance and
       * no sourceLang stamp — byte-identical.
       */
      sourceLang?: string | undefined;
      objectMeta?: object | undefined;
      /** Exact text to embed; defaults to `${predicate}: ${object}`. */
      embeddingText?: string | undefined;
      /** When supplied, skips the embed round-trip (batched mention path). */
      precomputedEmbedding?: number[] | undefined;
      confidence: number;
      validFrom: Date;
      validUntil?: Date | undefined;
      source: unknown;
      entropy?: number | undefined;
      /** Per-user scope (migration 0055); undefined = tenant-global. */
      userId?: string | undefined;
      /** Derived-world namespace (0074/0079); undefined = live world. */
      derivedVersion?: string | undefined;
      recordOutcomeMetric?: boolean | undefined;
    },
  ): Promise<{ result: ResolveOutcome; semantics: string }> {
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
  ): Promise<Array<{ result: ResolveOutcome; semantics: string }>> {
    if (inputs.length === 0) return [];
    const firstCompanyId = inputs[0]!.companyId; // inputs non-empty (checked)
    try {
      await this.predicateRegistry.getSnapshot(firstCompanyId);
    } catch (e) {
      this.logger.warn(
        `ingest: predicate registry getSnapshot failed for ${firstCompanyId}: ${(e as Error).message}; using seed policy`,
      );
    }

    const prepared = await Promise.all(inputs.map((p) => this.buildResolveCall(p)));
    const results: ResolveOutcome[] = new Array(inputs.length);
    const appendIdx: number[] = [];
    const restIdx: number[] = [];
    prepared.forEach((c, i) => (c.semantics === 'append_only' ? appendIdx : restIdx).push(i));

    if (appendIdx.length > 0) {
      try {
        const batch = await this.resolveAppendOnlyBatch(
          db,
          // appendIdx holds valid indices into `prepared` (built above).
          appendIdx.map((i) => prepared[i]!),
        );
        appendIdx.forEach((i, k) => (results[i] = batch[k]!));
      } catch (e) {
        this.logger.warn(
          `ingest: batched fact resolve fell back to per-fact: ${(e as Error).message}`,
        );
        for (const i of appendIdx) {
          results[i] = await this.resolveFactCall(db, prepared[i]!);
        }
      }
    }
    // single_active / bitemporal keep the serialized per-fact path.
    for (const i of restIdx) {
      results[i] = await this.resolveFactCall(db, prepared[i]!);
    }

    // Post-call side effects (HyPE + metric) per fact, in order.
    const out: Array<{ result: ResolveOutcome; semantics: string }> = [];
    for (let i = 0; i < inputs.length; i++) {
      // prepared.length === inputs.length ⇒ both indices are in-bounds.
      const input = inputs[i]!;
      const prep = prepared[i]!;
      const res = results[i]!;
      await this.postResolve(db, input, res);
      out.push({ result: res, semantics: prep.semantics });
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
    const sourceTrust = sourceTrustFor(p.source as Parameters<typeof sourceTrustFor>[0]);
    // Confidence-aware attribution (MULTILINGUAL_LANG_ATTRIBUTION, default
    // off). Off → detectLanguage keeps its Phase-4 `en` fallback and no new
    // metadata is built, so `lang`/`script` and the whole call are
    // byte-identical to today. On → the detector returns `und` for
    // short/stopword-less objects and we record confidence + source, and
    // inherit the source-turn language onto an undetectable object.
    const attribution = envFlagEnabled(process.env.MULTILINGUAL_LANG_ATTRIBUTION);
    const detLang = detectLanguage(p.object, attribution);
    let lang: string | undefined = detLang.language !== 'und' ? detLang.language : undefined;
    // Script is only ever the detected script — an inherited lang leaves it
    // NONE (the source turn's script isn't carried on the fact input).
    const script: string | undefined = detLang.language !== 'und' ? detLang.script : undefined;
    let langMeta: LangAttributionMeta | undefined;
    if (attribution) {
      if (lang) {
        langMeta = {
          langConfidence: detLang.confidence,
          langSource: 'detected',
          detectorVersion: detLang.detectorVersion,
          sourceLang: p.sourceLang,
        };
      } else if (p.sourceLang) {
        // Undetectable object (short / stopword-less / numeric): inherit
        // the source-message language as the contentLang — justified only
        // because the object carries no signal of its own. Recorded as
        // 'inherited'; script stays unknown (left NONE).
        lang = p.sourceLang;
        langMeta = {
          langConfidence: detLang.confidence,
          langSource: 'inherited',
          detectorVersion: detLang.detectorVersion,
          sourceLang: p.sourceLang,
        };
      } else {
        // Undetermined and nothing to inherit — record the low-confidence
        // `und` decision; `lang` stays NONE.
        langMeta = {
          langConfidence: detLang.confidence,
          langSource: 'detected',
          detectorVersion: detLang.detectorVersion,
          sourceLang: undefined,
        };
      }
      // Behaviour-neutral distribution telemetry (surface = 'fact').
      this.metrics?.recordLangAttribution({
        lang: lang ?? 'und',
        source: 'fact',
        confidence: detLang.confidence,
        detectorVersion: detLang.detectorVersion,
      });
    }
    const embedding =
      p.precomputedEmbedding ??
      (await this.factEmbedding.embed(p.embeddingText ?? `${p.predicate}: ${p.object}`));
    return {
      companyId: p.companyId,
      entityId: p.entityId,
      predicate: p.predicate,
      predicateAlias: p.predicateAlias,
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
      langMeta,
      entropy: p.entropy,
      userId: p.userId,
      derivedVersion: p.derivedVersion,
    };
  }

  /** Outcome metric — shared post-call tail. */
  private async postResolve(
    db: Surreal,
    p: Parameters<FactResolverService['resolve']>[1],
    result: ResolveOutcome,
  ): Promise<void> {
    const outcome = result?.outcome;
    if (p.recordOutcomeMetric && outcome) {
      this.metrics?.countIngestFact(String(outcome));
    }
    this.emitConflictOutcomes(p.companyId, result);
  }

  /** 0107 cap — bounds a pathological conflict fan-out. */
  private static readonly CONFLICT_OUTCOME_CAP = 20;

  /**
   * Outcome telemetry (0107): a resolver SUPERSEDED verdict is a
   * `contradicted` outcome for each standing fact the new one displaced;
   * a COMPETING verdict marks every party to the standoff — the standing
   * competitors AND the new fact. Runs in the shared post-call tail,
   * i.e. AFTER resolveFactCall returned — never inside the KeyedMutex
   * critical section — and the service detaches the write onto the root
   * pool (a telemetry failure warns, never fails the ingest). Guarded
   * no-op when the module isn't wired or the master flag is off. meta is
   * CONTENT-FREE: the winning fact id only.
   */
  private emitConflictOutcomes(companyId: string, result: ResolveOutcome): void {
    if (!this.outcomes || !MemoryOutcomeService.enabled()) return;
    const outcome = String(result?.outcome ?? '');
    const newFactId = result?.factId ? String(result.factId) : undefined;
    let subjects: string[] = [];
    if (outcome === 'SUPERSEDED') {
      subjects = ((result?.supersededFactIds as unknown[]) ?? []).map(String);
    } else if (outcome === 'COMPETING') {
      subjects = [
        ...((result?.competingFactIds as unknown[]) ?? []).map(String),
        ...(newFactId ? [newFactId] : []),
      ];
    }
    if (subjects.length === 0) return;
    const events: OutcomeEventInput[] = subjects
      .slice(0, FactResolverService.CONFLICT_OUTCOME_CAP)
      .map((id) => ({
        subjectKind: 'fact' as const,
        subjectId: id,
        event: 'contradicted' as const,
        ...(newFactId && id !== newFactId ? { meta: { byFactId: newFactId } } : {}),
      }));
    this.outcomes.recordOutcomes({ companyId, events });
  }

  /**
   * G6 scope-tag stamp (step 1): mirror the per-user scope onto the
   * row's `scope` column so new personal facts carry ['user:<id>'] the
   * way the 0093 backfill set it for existing rows — the forward half of
   * the backfill invariant. The fact CREATE itself lives inside the
   * audit-hardened `fn::resolve_fact`, which stamps `userId`; rather than
   * reopen that function we mirror the derived scope in a targeted
   * follow-up UPDATE on the row(s) it returned. No-op for tenant-global
   * writes (userId undefined → the field DEFAULT [] already holds), so
   * the benchmark/eval path (which never stamps a userId) is untouched.
   *
   * STAMPING ONLY — never authorization, and best-effort. The read fence
   * is composed with AND alongside the binding userId filter, so a fact
   * left at scope=[] by a failed stamp is still correctly fenced by
   * userId; the scope column can never OPEN access it lacks. A failure
   * therefore warns instead of failing the ingest.
   */
  private async stampFactScope(
    db: {
      query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
    },
    items: Array<{ userId?: string | undefined; factId: unknown }>,
  ): Promise<void> {
    const byUser = new Map<string, StringRecordId[]>();
    for (const it of items) {
      if (!it.userId || it.factId === undefined || it.factId === null) continue;
      const tail = idTailOf(String(it.factId));
      const ids = byUser.get(it.userId) ?? [];
      ids.push(new StringRecordId(`knowledge_fact:${tail}`));
      byUser.set(it.userId, ids);
    }
    if (byUser.size === 0) return;
    try {
      for (const [userId, ids] of byUser) {
        await db.query(`UPDATE knowledge_fact SET scope = $scope WHERE id IN $ids`, {
          scope: scopeForUser(userId),
          ids,
        });
      }
    } catch (e) {
      this.logger.warn(
        `scope-tag stamp failed (non-fatal, userId scope still fences): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Multilingual Tier 1 (0100): stamp confidence-aware attribution metadata
   * onto the created fact rows via a follow-up UPDATE — the stampFactScope
   * idiom, kept OUT of fn::resolve_fact so the resolver's pinned invariants
   * are untouched. Only rows whose langMeta is set (attribution on) are
   * touched, so with the flag off this is a no-op and ingest is
   * byte-identical. Best-effort: a stamp failure WARNs and never fails the
   * ingest (the `lang` column proper is already set by the resolver; these
   * are supplementary provenance fields). `sourceLang` is written only when
   * known — omitted, not NULLed, matching the omit-when-undefined idiom.
   */
  private async stampLangAttribution(
    db: {
      query: <T>(sql: string, params?: Record<string, unknown>) => Promise<T>;
    },
    items: Array<{ factId: unknown; meta?: LangAttributionMeta | undefined }>,
  ): Promise<void> {
    const rows = items.filter(
      (it): it is { factId: unknown; meta: LangAttributionMeta } =>
        it.meta !== undefined && it.factId !== undefined && it.factId !== null,
    );
    if (rows.length === 0) return;
    try {
      for (const { factId, meta } of rows) {
        const id = new StringRecordId(`knowledge_fact:${idTailOf(String(factId))}`);
        const sets = [
          'langConfidence = $langConfidence',
          'langSource = $langSource',
          'detectorVersion = $detectorVersion',
        ];
        const params: Record<string, unknown> = {
          id,
          langConfidence: meta.langConfidence,
          langSource: meta.langSource,
          detectorVersion: meta.detectorVersion,
        };
        if (meta.sourceLang !== undefined) {
          sets.push('sourceLang = $sourceLang');
          params.sourceLang = meta.sourceLang;
        }
        await db.query(`UPDATE $id SET ${sets.join(', ')}`, params);
      }
    } catch (e) {
      this.logger.warn(`lang-attribution stamp failed (non-fatal): ${(e as Error).message}`);
    }
  }

  /**
   * Resolve a set of append_only facts in ONE round-trip via the stored
   * `fn::resolve_facts` (migration 0071), which maps `fn::resolve_fact` over the
   * array server-side and returns the results in order. Safe without the resolve
   * lock: append_only never supersedes and never asserts a unique active row, so
   * batched inserts are all correct.
   *
   * The 25-arg positional binding (0084) lives in the migration, NOT here — the TS side
   * passes a TYPED object array + one shared config, so a fn::resolve_fact
   * signature change can't silently drift a hand-built parameter string.
   * Optional fields are omitted when undefined so `$f.x` resolves to NONE
   * (matching the per-fact path), never NULL.
   */
  private async resolveAppendOnlyBatch(
    db: Surreal,
    prepared: Parameters<FactResolverService['resolveFactCall']>[1][],
  ): Promise<ResolveOutcome[]> {
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
      if (c.predicateAlias !== undefined) f.predicate_alias = c.predicateAlias;
      if (c.objectMeta !== undefined) f.object_meta = c.objectMeta;
      if (c.validUntil !== undefined) f.valid_until = c.validUntil;
      if (c.lang !== undefined) f.lang = c.lang;
      if (c.script !== undefined) f.script = c.script;
      if (c.entropy !== undefined) f.entropy = c.entropy;
      if (c.userId !== undefined) f.user_id = c.userId;
      if (c.derivedVersion !== undefined) f.derived_version = c.derivedVersion;
      return f;
    });
    const cfg = {
      similarity_threshold: this.conflict.similarityThreshold,
      slot_similarity: this.conflict.slotSimilarityThreshold,
      w_confidence: this.conflict.weights.confidence,
      w_source_trust: this.conflict.weights.sourceTrust,
      w_recency: this.conflict.weights.recency,
      w_authority: this.conflict.weights.authority,
      reject_threshold: this.conflict.rejectThreshold,
      margin_for_supersede: this.conflict.marginForSupersede,
    };
    const out = await queryRows<ResolveOutcome>(db, `RETURN fn::resolve_facts($facts, $cfg)`, {
      facts,
      cfg,
    });
    await this.stampFactScope(
      db,
      prepared.map((c, k) => ({ userId: c.userId, factId: out[k]?.factId })),
    );
    // Multilingual Tier 1: per-fact attribution stamp (0100). No-op for
    // every fact whose langMeta is undefined (attribution off, or the
    // derived-batch path which builds no attribution meta) — byte-identical.
    await this.stampLangAttribution(
      db,
      prepared.map((c, k) => ({ factId: out[k]?.factId, meta: c.langMeta })),
    );
    // Drift-1 (0115): grounding-status stamp on the winner rows — the
    // same post-resolve seam, gated inside on EVIDENCE_GROUNDING_STAMP
    // (off ⇒ immediate return, byte-identical). See grounding-stamp.ts.
    await stampGroundingStatus({
      db,
      items: prepared.map((c, k) => ({
        factId: out[k]?.factId,
        outcome: out[k]?.outcome,
        source: c.source,
      })),
      logger: this.logger,
    });
    return out;
  }

  /**
   * Derived-world batch write (S4, one write primitive): every producer
   * routes through fn::resolve_fact — including the window deriver,
   * which used to raw-INSERT past the resolver. Propositions carry
   * their derivedVersion, so resolution is namespace-local (0079) and
   * the batch stays ONE round-trip per session via fn::resolve_facts.
   *
   * V9 §1 (DERIVER_SLOT_SEMANTICS → opts.slotSemantics): value-bearing
   * aspects take 'bitemporal_event' — the similarity+interval-gated
   * competing pool with EVENT-TIME recency and later-validFrom-wins
   * supersede (migration 0083) — so derived worlds get a knowledge-
   * update lifecycle. Event-like aspects stay append_only (history
   * matters, no unique active slot). Off → byte-identical.
   *
   * Batching stays safe for the mixed batch: derive is per-conversation
   * sequential (sessions resolve in order inside one statement), so the
   * cross-request race the KeyedMutex guards on the live path cannot
   * occur here.
   */
  async resolveDerivedBatch(
    // Structural: the deriver hands a narrow query-only view of the
    // scoped connection; resolveAppendOnlyBatch only calls .query().
    db: {
      query<T>(sql: string, params?: Record<string, unknown>): Promise<T>;
    },
    rows: Array<{
      entityId: string;
      predicate: string;
      object: string;
      embedding: number[];
      confidence: number;
      validFrom: Date;
      source: unknown;
      sourceTrust: number;
      lang?: string;
      script?: string;
      derivedVersion: string;
      /** Per-user scope of the grounding turns (audit 2026-08-21 P0) —
       *  absent = tenant-global. Conflict resolution is scope-local
       *  (0055: fn::resolve_fact scopes candidates by $user_id). */
      userId?: string;
    }>,
    opts: { slotSemantics?: boolean } = {},
  ): Promise<ResolveOutcome[]> {
    if (rows.length === 0) return [];
    const prepared = rows.map((r) => ({
      companyId: '',
      entityId: r.entityId,
      predicate: r.predicate,
      object: r.object,
      embedding: r.embedding,
      confidence: r.confidence,
      validFrom: r.validFrom,
      source: r.source,
      sourceTrust: r.sourceTrust,
      semantics: derivedSemanticsFor(r.predicate, opts.slotSemantics === true),
      lang: r.lang,
      script: r.script,
      derivedVersion: r.derivedVersion,
      userId: r.userId,
    }));
    try {
      return (await this.resolveAppendOnlyBatch(
        db as unknown as Surreal,
        prepared,
      )) as ResolveOutcome[];
    } catch (e) {
      // V9 phase 0 fence: the V8 conv-42 failure ("Cannot execute
      // UPDATE statement using value: NONE", data-dependent) killed the
      // WHOLE conversation because one poisoned row aborted the single
      // fn::resolve_facts statement. Retry per row so the batch
      // degrades to N-1 good rows + a WARN per bad one instead of a
      // skipped conversation.
      this.logger.warn(`derived batch resolve failed (${(e as Error).message}); retrying per-row`);
      const out: ResolveOutcome[] = [];
      for (const c of prepared) {
        try {
          const [r] = await this.resolveAppendOnlyBatch(db as unknown as Surreal, [c]);
          out.push(r as ResolveOutcome);
        } catch (rowErr) {
          this.logger.warn(
            `derived row skipped (entity=${c.entityId}, predicate=${c.predicate}): ${(rowErr as Error).message}`,
          );
          out.push({
            outcome: 'SKIPPED',
            factId: null,
            reason: (rowErr as Error).message,
          });
        }
      }
      return out;
    }
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
  private async resolveFactCall(
    db: Surreal,
    p: {
      companyId: string;
      entityId: string;
      predicate: string;
      predicateAlias?: string | undefined;
      object: string;
      objectMeta?: object | undefined;
      embedding: number[];
      confidence: number;
      validFrom: Date;
      validUntil?: Date | undefined;
      source: unknown;
      sourceTrust: number;
      semantics: string;
      lang?: string | undefined;
      script?: string | undefined;
      /** Attribution metadata (0100), stamped by a follow-up UPDATE; not
       *  passed to fn::resolve_fact. Undefined ⇒ no stamp. */
      langMeta?: LangAttributionMeta | undefined;
      entropy?: number | undefined;
      userId?: string | undefined;
      derivedVersion?: string | undefined;
    },
  ): Promise<ResolveOutcome> {
    // Serialize resolves on the same (company, entity, predicate). Under
    // SurrealDB 3.x the OCC read-conflict that let racing single_active
    // resolves retry-and-supersede no longer fires for the function's
    // SELECT-then-write, so without this two concurrent ingests could
    // each leave an `active` row. NUL-joined (\x00) — no entity record tail
    // or predicate slug can contain a NUL, so the composite key can't
    // collide.
    // Keyed on the CANONICAL predicate (0082) so two coinages of one
    // canon serialize onto the same slot — their candidate sets are the
    // same rows now that resolution keys on `predicateAlias ?? predicate`.
    const lockKey = `${p.companyId}\x00${p.entityId}\x00${p.predicateAlias ?? p.predicate}`;
    const r = await this.resolveLock.run(lockKey, () =>
      retryOnUniqueViolation(async () => {
        const [row] = await db.query<[ResolveOutcome]>(
          `RETURN fn::resolve_fact(
            type::record('knowledge_entity', $eid),
            $predicate, $object, $object_meta, $embedding,
            $confidence, $valid_from, $valid_until, $source,
            $source_trust, $semantics, $similarity_threshold,
            $w_confidence, $w_source_trust, $w_recency, $w_authority,
            $reject_threshold, $margin_for_supersede,
            $lang, $script, $entropy, $user_id, $derived_version,
            $predicate_alias, $slot_similarity
         )`,
          {
            eid: idTailOf(p.entityId),
            predicate: p.predicate,
            predicate_alias: p.predicateAlias,
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
            slot_similarity: this.conflict.slotSimilarityThreshold,
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
            derived_version: p.derivedVersion,
          },
        );
        return row;
      }),
    );
    // G6 step 1: mirror the userId scope onto the new row's scope column.
    // Outside the retry closure so a stamp hiccup never re-runs the
    // resolver (which would double-create the fact).
    await this.stampFactScope(db, [{ userId: p.userId, factId: r?.factId }]);
    // Multilingual Tier 1: stamp attribution metadata (0100). No-op when
    // langMeta is undefined (attribution off) — byte-identical.
    await this.stampLangAttribution(db, [{ factId: r?.factId, meta: p.langMeta }]);
    // Drift-1 (0115): grounding-status stamp on the winner row — gated
    // inside on EVIDENCE_GROUNDING_STAMP (off ⇒ immediate return,
    // byte-identical). See grounding-stamp.ts.
    await stampGroundingStatus({
      db,
      items: [{ factId: r?.factId, outcome: r?.outcome, source: p.source }],
      logger: this.logger,
    });
    return r;
  }

  private cfgNum(key: string, fallback: number): number {
    const v = process.env[key];
    // Set-but-blank (a common env-file shape) must fall back, not
    // collapse through Number('') === 0 — a zero DERIVER_SLOT_SIMILARITY
    // would open the 0084 competing-pool gate to everything.
    if (v === undefined || v.trim() === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
}
