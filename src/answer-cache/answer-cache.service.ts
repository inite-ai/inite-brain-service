import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { pinUserScope } from '../auth/user-scope';
import { makeRowPolicyFilter } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { MetricsService } from '../metrics/metrics.service';
import { ReadPinService, type ReadPin } from '../episodes/read-pin.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeDto } from '../synthesize/dto/synthesize.dto';
import type { SynthesizeResult } from '../synthesize/synthesize.types';
import type { Citation } from '../synthesize/fact-index';

/**
 * Generator/verifier PROMPT SHAPE version baked into the cache key.
 * The stored answer is a function of the prompt assembly, not only of
 * the evidence: a change to the generator system prompt, the fact-line
 * rendering, or the frame sections can change what the same facts
 * produce — and none of that is visible in the profile or the model
 * id. Bump this constant MANUALLY in the PR that changes prompt shape;
 * every existing entry then misses by key construction (no sweep
 * needed, TTL reaps the orphans).
 */
export const ANSWER_CACHE_PROMPT_VERSION = 1;

/** Table + record-id namespace of the cache rows (migration 0091). */
const TABLE = 'answer_cache';

/** Mirrors the migration-0091 ASSERT on answer_cache.invalidationCause. */
export type InvalidationCause =
  | 'superseded'
  | 'retracted'
  | 'expired_validity'
  | 'missing';

/**
 * Exact-match key normalization: NFC unicode form, lowercase, collapsed
 * whitespace, trailing punctuation stripped. Deliberately conservative
 * — two queries share a key only when they are the same question up to
 * typography. NO stemming, NO stopwords, NO embeddings (v1 doctrine:
 * zero false-hit surface by construction).
 */
export function normalizeQuery(query: string): string {
  return query
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?…]+$/u, '')
    .trim();
}

/** Recursively key-sorted JSON — Sets become sorted arrays, undefined
 *  object values drop (JSON.stringify parity). Deterministic across
 *  property insertion order, so it is a stable hash input. */
export function deterministicSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (v instanceof Set) {
    return [...v].map((e) => sortValue(e)).sort();
  }
  if (Array.isArray(v)) return v.map((e) => sortValue(e));
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] !== undefined) out[k] = sortValue(src[k]);
    }
    return out;
  }
  return v;
}

/**
 * Hash of everything configuration-shaped that can change the answer
 * for the same query text: the RESOLVED per-tenant retrieval profile
 * (every field, lanes Set included) plus the synthesize knobs of this
 * request (guardrails and the full retrieval-lever surface of the DTO
 * — asOf, predicates, searchMode, limit, …). Fail-closed by
 * construction: any lever difference is a different key, never a
 * near-miss serve.
 */
export function computeProfileHash(
  profile: RetrievalProfile,
  knobs: Record<string, unknown>,
): string {
  return sha256(deterministicSerialize({ knobs, profile }));
}

/** Canonical string form of the derived-world read pin (a world flip —
 *  single, union, or legacy — must flip the key). */
export function canonicalDerivedPin(pin: ReadPin): string {
  if (pin === null) return '-';
  if (typeof pin === 'string') return pin;
  return [...new Set(pin)].sort().join('+');
}

export interface AnswerCacheKeyInput {
  companyId: string;
  /** Pinned end-user scope; undefined = tenant-global (M2M). */
  userId?: string | undefined;
  profileHash: string;
  model: string;
  derivedVersionPin: ReadPin;
  query: string;
}

/** SHA256 of `companyId|userId or '-'|profileHash|model|promptVersion|
 *  derivedVersionPin|normalized(query)` — the row's queryHash AND its
 *  record id (idempotent admission via UPSERT on the same id). */
export function computeCacheKey(input: AnswerCacheKeyInput): string {
  return sha256(
    [
      input.companyId,
      input.userId ?? '-',
      input.profileHash,
      input.model,
      String(ANSWER_CACHE_PROMPT_VERSION),
      canonicalDerivedPin(input.derivedVersionPin),
      normalizeQuery(input.query),
    ].join('|'),
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Everything the admission hook needs, computed once by begin(). */
export interface AnswerCacheStoreContext {
  key: string;
  companyId: string;
  userId?: string | undefined;
  profileHash: string;
  model: string;
  normalizedQuery: string;
}

export interface AnswerCacheBeginResult {
  /** Served result (check-on-read passed) — return it as-is. */
  hit?: SynthesizeResult;
  /** Miss: carry to the admission hook after fresh synthesis. */
  ctx?: AnswerCacheStoreContext;
}

interface CacheRow {
  id: unknown;
  answer: string;
  citedFactIds: string[];
  entityIds: string[];
  expiresAt: Date | string;
  invalidatedAt?: Date | string | null;
}

interface CitedFactRow {
  id: unknown;
  predicate: string;
  object: string;
  entityId?: unknown;
  status: string;
  validUntil?: Date | string | null;
  retractedAt?: Date | string | null;
  userId?: string | null;
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
}

/**
 * AnswerCacheService — G1 fact-lifecycle-gated answer reuse
 * (docs/roadmap/sota-gap-build-2026-08.md).
 *
 * Serving tier: EXACT normalized-key match only, gated by CHECK-ON-READ
 * — one batch re-read of the cited facts through the same user-scope
 * pin and row-policy fences the fact read path applies. The entry
 * serves only while every cited fact is still `active` and inside its
 * validity window; any failure (superseded / retracted / expired
 * validity / missing-or-fenced) stamps the entry invalidated with its
 * cause and the request falls through to fresh synthesis. Fail-closed:
 * there are no events on the serving path, so a lost event can never
 * serve a dead fact. Poisoning posture: admission only from verified
 * grounded answers, per-user key partitioning (NDSS'26 semantic-cache
 * poisoning + CacheAttack both exploit shared/unverified admission).
 *
 * v2 (deferred by design): embedding-similarity candidates promoted to
 * servable only after async judge verification — never served
 * unverified. TODO(G7): the sleep-time consolidation sweep should also
 * reap expired/invalidated rows in bulk (memory_diff-style); v1 relies
 * on check-on-read + TTL for correctness and the per-tenant expiresAt
 * index makes that sweep a range scan.
 */
@Injectable()
export class AnswerCacheService {
  private readonly logger = new Logger(AnswerCacheService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly surreal: SurrealService,
    private readonly configService: ConfigService,
    @Optional() private readonly readPin?: ReadPinService,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Serving hook — call at synthesize entry, after auth/scope/profile
   * resolution and BEFORE retrieval. Returns undefined when the cache
   * is disabled; `{hit}` on a served answer; `{ctx}` on a miss (hand
   * ctx to admit() after fresh synthesis).
   */
  async begin(opts: {
    companyId: string;
    dto: SynthesizeDto;
    callerScopes: string[];
    profile: RetrievalProfile;
    model: string;
    guardrails: string;
  }): Promise<AnswerCacheBeginResult | undefined> {
    // Read per-request (never captured at boot) so a live env flip
    // lands on the next request — runtimeMutable, catalog-verified.
    if (
      !envFlagEnabled(
        this.configService.get<string>('SYNTHESIZE_ANSWER_CACHE'),
      )
    ) {
      return undefined;
    }
    // explain=true asks for a per-fact DecisionLog a stored answer
    // cannot carry — those requests bypass both serve and admit.
    const normalizedQuery = normalizeQuery(opts.dto.query ?? '');
    if (opts.dto.explain === true || normalizedQuery.length === 0) {
      this.metrics?.countAnswerCache('bypass');
      return undefined;
    }
    try {
      const ctx = await this.buildContext(opts, normalizedQuery);
      const hit = await this.tryServe(ctx, opts.callerScopes);
      if (hit) {
        this.metrics?.countAnswerCache('hit');
        return { hit };
      }
      return { ctx };
    } catch (e) {
      // Fail-closed to a plain miss — a broken cache must never break
      // (or slow-fail) the synthesis path.
      this.logger.warn(
        `answer-cache serve failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      this.metrics?.countAnswerCache('miss');
      return undefined;
    }
  }

  /**
   * Admission hook (write-through) — call with the finalizeVerdict
   * result. Admits ONLY a verifier-supported grounded answer: verdict
   * 'supported', non-null answer, no reason tag, non-empty citations.
   * Abstentions, unverified returns, low_coverage and partial verdicts
   * are never cached — an uncited answer is uninvalidatable, and a
   * non-supported one failed the grounding audit.
   */
  async admit(
    ctx: AnswerCacheStoreContext,
    result: SynthesizeResult,
    verdict: 'supported' | 'partial' | 'unsupported',
  ): Promise<void> {
    if (
      verdict !== 'supported' ||
      result.answer === null ||
      result.reason !== undefined ||
      result.citations.length === 0
    ) {
      return;
    }
    const ttlHours = this.ttlHours();
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    const answer = result.answer;
    const citedFactIds = result.citations.map((c) => c.factId);
    const entityIds = [
      ...new Set(result.citations.map((c) => c.entityId).filter(Boolean)),
    ];
    try {
      await this.surreal.withCompany(ctx.companyId, async (db) => {
        // Record id = queryHash, so re-admission after invalidation or
        // TTL expiry REPLACES the row in place (the unique
        // (companyId, queryHash) index stays trivially consistent).
        // option<string> userId: NONE (not NULL) when tenant-global —
        // the literal is spliced because the SDK has no NONE binding.
        await db.query(
          `UPSERT type::record($tb, $key) CONTENT {
             companyId: $companyId,
             userId: ${ctx.userId ? '$userId' : 'NONE'},
             queryHash: $key,
             queryText: $queryText,
             answer: $answer,
             reason: '',
             citedFactIds: $citedFactIds,
             entityIds: $entityIds,
             profileHash: $profileHash,
             modelId: $modelId,
             promptVersion: $promptVersion,
             createdAt: time::now(),
             expiresAt: $expiresAt,
             hitCount: 0,
             lastServedAt: NONE,
             invalidatedAt: NONE,
             invalidationCause: NONE
           }`,
          {
            tb: TABLE,
            key: ctx.key,
            companyId: ctx.companyId,
            ...(ctx.userId ? { userId: ctx.userId } : {}),
            queryText: ctx.normalizedQuery,
            answer,
            citedFactIds,
            entityIds,
            profileHash: ctx.profileHash,
            modelId: ctx.model,
            promptVersion: ANSWER_CACHE_PROMPT_VERSION,
            expiresAt,
          },
        );
      });
      this.metrics?.countAnswerCache('stored');
    } catch (e) {
      this.logger.warn(
        `answer-cache store failed (companyId=${ctx.companyId}): ${(e as Error).message}`,
      );
    }
  }

  private ttlHours(): number {
    const raw = this.configService.get<string>(
      'SYNTHESIZE_ANSWER_CACHE_TTL_HOURS',
      '24',
    );
    const v = parseInt(raw, 10);
    return Number.isFinite(v) && v > 0 ? v : 24;
  }

  private async buildContext(
    opts: {
      companyId: string;
      dto: SynthesizeDto;
      profile: RetrievalProfile;
      model: string;
      guardrails: string;
    },
    normalizedQuery: string,
  ): Promise<AnswerCacheStoreContext> {
    // Same read-pin resolution the search pipeline applies
    // (search.service.ts): registry live row per tenant, env bootstrap
    // fallback, multiworld union folded in — a derive world-flip
    // changes the pin and therefore the key.
    const derivedVersionPin =
      (await this.readPin?.resolveRead(opts.companyId)) ??
      ReadPinService.bootstrapRead();
    // Key partition = pinned user scope (dto.userId is already pinned
    // by synthesize()); tenant-global (M2M, no user) entries and
    // user-scoped entries can never collide.
    const userId = opts.dto.userId || undefined;
    // Knobs: guardrails + every retrieval lever on the DTO except the
    // key-carried query/userId and the bypassed explain. The whole DTO
    // rides the hash so ANY lever (asOf, predicates, searchMode,
    // limit, tokenBudget, …) partitions the key — fail-closed against
    // serving across differently-shaped requests.
    const dtoKnobs: Record<string, unknown> = { ...opts.dto };
    delete dtoKnobs.query;
    delete dtoKnobs.userId;
    delete dtoKnobs.explain;
    const profileHash = computeProfileHash(opts.profile, {
      guardrails: opts.guardrails,
      dto: dtoKnobs,
    });
    return {
      key: computeCacheKey({
        companyId: opts.companyId,
        userId,
        profileHash,
        model: opts.model,
        derivedVersionPin,
        query: normalizedQuery,
      }),
      companyId: opts.companyId,
      userId,
      profileHash,
      model: opts.model,
      normalizedQuery,
    };
  }

  /** Lookup + check-on-read + serve bookkeeping. Null = miss. */
  private async tryServe(
    ctx: AnswerCacheStoreContext,
    callerScopes: string[],
  ): Promise<SynthesizeResult | null> {
    const row = await this.surreal.withCompany(ctx.companyId, async (db) => {
      // The key hash already encodes tenant + user, but the WHERE
      // clause double-fences both (a user-scoped query must never hit
      // a global entry and vice versa).
      const [rows] = await db.query<[CacheRow[]]>(
        `SELECT id, answer, citedFactIds, entityIds, expiresAt,
                invalidatedAt
           FROM type::record($tb, $key)
          WHERE companyId = $companyId
            AND queryHash = $key
            AND ${ctx.userId ? 'userId = $userId' : 'userId IS NONE'}
          LIMIT 1`,
        {
          tb: TABLE,
          key: ctx.key,
          companyId: ctx.companyId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
        },
      );
      return rows?.[0];
    });
    if (!row || row.invalidatedAt || toMs(row.expiresAt) <= Date.now()) {
      this.metrics?.countAnswerCache('miss');
      return null;
    }
    const verdict = await this.checkOnRead(ctx, row, callerScopes);
    if ('cause' in verdict) {
      await this.invalidate(ctx, verdict.cause);
      this.metrics?.countAnswerCache('rejected_stale');
      return null;
    }
    await this.recordServe(ctx);
    return {
      answer: row.answer,
      citations: verdict.citations,
      // A cached serve skipped retrieval — there is no hit list to
      // return; the citations above are rebuilt from the LIVE fact
      // rows the check-on-read just validated.
      results: [],
      cached: true,
    };
  }

  /**
   * CHECK-ON-READ — the correctness core. One batch SELECT of the
   * cited facts through the SAME fences the fact read path applies
   * (facts.service.ts loadVisibleFact): user-scope pin via
   * pinUserScope + registry-backed row policy via makeRowPolicyFilter.
   * Fail-closed: a fact that is absent OR fenced away from this caller
   * is 'missing' (indistinguishable by design — existence never
   * leaks); any fence uncertainty is a miss, never a serve.
   */
  private async checkOnRead(
    ctx: AnswerCacheStoreContext,
    row: CacheRow,
    callerScopes: string[],
  ): Promise<{ cause: InvalidationCause } | { citations: Citation[] }> {
    const ids = row.citedFactIds ?? [];
    if (ids.length === 0) return { cause: 'missing' };
    const { facts, names } = await this.surreal.withScopedCompany(
      ctx.companyId,
      callerScopes,
      async (db) => {
        const [factRows, entityRows] = await db.query<
          [CitedFactRow[], Array<{ id: unknown; canonicalName: string }>]
        >(
          `SELECT id, predicate, object, entityId, status, validUntil,
                  retractedAt, userId, source, trustSnapshot, corroboration
             FROM knowledge_fact WHERE id INSIDE $ids;
           SELECT id, canonicalName FROM knowledge_entity
            WHERE id INSIDE $entityIds`,
          {
            ids: ids.map((id) => new StringRecordId(id)),
            entityIds: (row.entityIds ?? []).map(
              (id) => new StringRecordId(id),
            ),
          },
        );
        return { facts: factRows ?? [], names: entityRows ?? [] };
      },
    );
    const byId = new Map(facts.map((f) => [String(f.id), f]));
    const nameById = new Map(
      names.map((e) => [String(e.id), e.canonicalName]),
    );
    // Same user-scope semantics as loadVisibleFact: a user-bound token
    // sees tenant-global facts + its own; M2M (no pinned user) sees all.
    const scopeUserId = pinUserScope(undefined);
    const rowPolicy = makeRowPolicyFilter({
      callerScopes,
      surface: 'answer_cache_read',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(
        ctx.companyId,
      ),
    });
    const citations: Citation[] = [];
    let cause: InvalidationCause | undefined;
    for (const id of ids) {
      const fact = byId.get(id);
      if (!fact) {
        cause = 'missing';
        break;
      }
      if (
        scopeUserId !== undefined &&
        typeof fact.userId === 'string' &&
        fact.userId.length > 0 &&
        fact.userId !== scopeUserId
      ) {
        cause = 'missing'; // fenced = absent, existence never leaks
        break;
      }
      if (!rowPolicy.filter(fact)) {
        cause = 'missing';
        break;
      }
      if (fact.status === 'retracted' || fact.retractedAt) {
        cause = 'retracted';
        break;
      }
      if (fact.status === 'superseded') {
        cause = 'superseded';
        break;
      }
      if (fact.status !== 'active') {
        // competing/compacted — the fact left the servable lifecycle
        // state the answer was verified against; fail closed.
        cause = 'missing';
        break;
      }
      if (fact.validUntil && toMs(fact.validUntil) <= Date.now()) {
        cause = 'expired_validity';
        break;
      }
      citations.push({
        factId: id,
        entityId: String(fact.entityId ?? ''),
        canonicalName: nameById.get(String(fact.entityId ?? '')) ?? '',
        predicate: fact.predicate,
        object: fact.object,
      });
    }
    rowPolicy.finish();
    return cause ? { cause } : { citations };
  }

  private async invalidate(
    ctx: AnswerCacheStoreContext,
    cause: InvalidationCause,
  ): Promise<void> {
    try {
      await this.surreal.withCompany(ctx.companyId, async (db) => {
        await db.query(
          `UPDATE type::record($tb, $key) SET
             invalidatedAt = time::now(),
             invalidationCause = $cause
           WHERE companyId = $companyId`,
          { tb: TABLE, key: ctx.key, companyId: ctx.companyId, cause },
        );
      });
    } catch (e) {
      this.logger.warn(
        `answer-cache invalidate failed (companyId=${ctx.companyId}): ${(e as Error).message}`,
      );
    }
  }

  private async recordServe(ctx: AnswerCacheStoreContext): Promise<void> {
    try {
      await this.surreal.withCompany(ctx.companyId, async (db) => {
        await db.query(
          `UPDATE type::record($tb, $key) SET
             hitCount += 1,
             lastServedAt = time::now()
           WHERE companyId = $companyId`,
          { tb: TABLE, key: ctx.key, companyId: ctx.companyId },
        );
      });
    } catch (e) {
      // Bookkeeping only — the serve itself already succeeded.
      this.logger.warn(
        `answer-cache hit bookkeeping failed (companyId=${ctx.companyId}): ${(e as Error).message}`,
      );
    }
  }
}

function toMs(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}
