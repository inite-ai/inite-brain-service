import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { pinUserScope } from '../auth/user-scope';
import { makeRowPolicyFilter, type RowPolicyFilter } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { MetricsService } from '../metrics/metrics.service';
import { ReadPinService, type ReadPin } from '../episodes/read-pin.service';
import { detectEnumerationShape } from '../synthesize/answer-router';
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

/** Mirrors the migration-0091/0097 ASSERT on answer_cache.invalidationCause.
 *  `newer_fact` (0097) = the additive-write freshness cause: a NEW active
 *  fact appeared on a cited entity after the answer was built. */
export type InvalidationCause =
  'superseded' | 'retracted' | 'expired_validity' | 'missing' | 'newer_fact';

/** Cap on freshness-probe candidate rows pulled per read. The probe only
 *  needs existence of ONE scope+policy-visible newer fact.
 *
 *  Gap 1 (cap-before-scope): the DB query applies the user-scope gate in
 *  SQL, but the ABAC row policy + predicate-scope gate can only be applied
 *  in JS, AFTER the DB LIMIT. So a naive `LIMIT cap` could hand back `cap`
 *  rows that the row policy will all discard while a genuinely visible
 *  newer fact sits beyond the cap — a stale serve. The fix: fetch cap + 1
 *  and treat a FULL page (> cap candidates) as fail-closed evidence of an
 *  additive write (invalidate), because the JS fences ran only over the
 *  returned page and a visible fact could sit past it. A false invalidation
 *  costs one cache miss; a stale serve is a correctness bug. Under the cap,
 *  the page is EXHAUSTIVE — every newer fact was seen — so the visible-fact
 *  check is exact. See hasNewerVisibleFact. */
const FRESHNESS_PROBE_CAP = 25;

/**
 * Exact-match key normalization: Unicode NFC form + whitespace collapse
 * ONLY. Deliberately conservative — two queries share a key only when
 * they are byte-identical up to unicode composition and runs of
 * whitespace. NO case-folding (F1: `getUserById` and `getuserbyid` are
 * distinct identifiers and must not collide), NO trailing-punctuation
 * stripping ("do it." vs "do it?" can be different questions), NO
 * stemming, NO stopwords, NO embeddings (v1 doctrine: zero false-hit
 * surface by construction). The key already partitions on
 * company/user/profile/model/prompt-version/derived-pin, so tightening
 * the text normalization only ever narrows a hit, never widens one.
 */
export function normalizeQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/g, ' ').trim();
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
  /** Open-enumeration query shape ("list all X" / counting / ordering) —
   *  admit() keys a shorter TTL on it (additive writes on NOT-yet-cited
   *  entities escape the entity-scoped freshness probe). */
  isEnumeration: boolean;
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
  /** Answer admission time — the freshness probe's "newer than" cutoff. */
  createdAt: Date | string;
  expiresAt: Date | string;
  invalidatedAt?: Date | string | null;
}

/** The two read fences the fact read path applies, threaded together
 *  into the cited-fact check and the freshness probe so both enforce the
 *  IDENTICAL user-scope pin + row policy. */
interface ReadFences {
  scopeUserId: string | undefined;
  rowPolicy: RowPolicyFilter;
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
 * Serving tier: EXACT normalized-key match only (NFC + whitespace-
 * collapse; case- and punctuation-preserving so distinct identifiers
 * never collide), gated by CHECK-ON-READ — one batch re-read of the
 * cited facts PLUS an additive-write freshness probe, all through the
 * same user-scope pin and row-policy fences the fact read path applies.
 * The entry serves only while every cited fact is still `active` and
 * inside its validity window AND no newer visible fact has appeared on a
 * cited entity since the answer was built; any failure (superseded /
 * retracted / expired validity / missing-or-fenced / newer_fact) stamps
 * the entry invalidated with its cause and the request falls through to
 * fresh synthesis. The `newer_fact` axis (audit F1) closes the additive
 * hole: an answer whose cited facts all stay active is still invalidated
 * when a NEW active fact lands on one of its entities (the cat→dog case).
 * The probe is fetched cap+1 and a full page fails closed, so a
 * row-policy-visible newer fact can never be hidden behind a crowd of
 * fenced-away rows past the cap (hardening gap 1). It only covers the
 * answer's CITED entities: a newly-relevant fact on a BRAND-NEW entity
 * cannot be seen without re-retrieval, so that residual is bounded — for
 * EVERY answer — only by the TTL (the operator-set new-entity staleness
 * knob, hardening gap 2; no claim of full freshness beyond it).
 * Open-enumeration answers — detected by query shape OR, language-
 * agnostically, by a broad cited-fact count (hardening gap 3) —
 * additionally carry a much shorter TTL, since their additive item most
 * often lands on an entity the probe does not cover.
 * Fail-closed: there are no events on the serving path, so a lost event
 * can never serve a dead fact. Poisoning posture: admission only from
 * verified grounded answers, per-user key partitioning (NDSS'26
 * semantic-cache poisoning + CacheAttack both exploit shared/unverified
 * admission).
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
    if (!envFlagEnabled(this.configService.get<string>('SYNTHESIZE_ANSWER_CACHE'))) {
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
   *
   * L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS) are DELIBERATELY
   * not admission-bearing: an episode-only-cited L3 answer (zero fact
   * citations, ≥1 evidence citation) has citations.length 0 and is
   * rejected by the gate below. Check-on-read revalidates cited FACT
   * rows against the live substrate and cannot (yet) invalidate episode
   * citations, so caching such an answer would make it uninvalidatable.
   * The BELIEF arm (BELIEFS_SERVING_LANE) rides the same doctrine: a
   * belief-only-cited current-state answer has citations.length 0 and
   * is rejected here too — check-on-read cannot invalidate a belief
   * citation against the supersede chain, so caching it would serve a
   * stale current-state answer past the next revision.
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
    const answer = result.answer;
    const citedFactIds = result.citations.map((c) => c.factId);
    const entityIds = [...new Set(result.citations.map((c) => c.entityId).filter(Boolean))];
    // Gap 3 — language-agnostic enum guard. ctx.isEnumeration keys on the
    // English ENUMERATION_PATTERNS ("list all X" / "how many …"), so a
    // non-English enumeration (the service answers 12 languages; see
    // ai/locale/language-detector.ts) misses the short-TTL guard while
    // carrying the SAME new-entity exposure. Add a LANGUAGE-AGNOSTIC
    // answer-shape signal that needs no query-language regex: an answer
    // that enumerated many items (cited-fact count ≥ threshold) is an open
    // list whatever the query's language, and its next item is exactly the
    // kind of additive write that lands on a not-yet-cited entity the
    // freshness probe can't see. Either signal drops the entry to the short
    // TTL. Off (default threshold) never shortens a small factoid answer.
    const broadAnswer =
      citedFactIds.length >= this.readPositiveInt('SYNTHESIZE_ANSWER_CACHE_ENUM_MIN_CITATIONS', 5);
    const ttlHours = this.ttlHours(ctx.isEnumeration || broadAnswer);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
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

  /**
   * TTL in hours — the bounded staleness window.
   *
   * Gap 2 (the new-entity residual): the freshness probe scans only the
   * answer's CITED entities. A newly-relevant fact on a BRAND-NEW entity —
   * one the original retrieval never touched, so it is not in entityIds —
   * cannot be probed without re-running retrieval, which the cache exists
   * to avoid. That residual is real for EVERY cached answer (a new entity
   * is always possible), and it is bounded ONLY by the TTL. So the regular
   * TTL (SYNTHESIZE_ANSWER_CACHE_TTL_HOURS, default 24) is not just a reaper
   * — it is the operator-set global new-entity staleness bound. Lower it to
   * tighten that bound; there is no claim of full freshness beyond it.
   *
   * `shortWindow` answers (open enumerations by query shape OR by the
   * language-agnostic broad-answer signal — see admit()) get
   * min(regular, SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS, default 1): their
   * additive item most often lands on an entity NOT among the citations,
   * exactly the new-entity blind spot, so they carry a tighter bound. The
   * min() guarantees the short window can only ever be SHORTER than the
   * regular one, whatever the operator sets.
   */
  private ttlHours(shortWindow: boolean): number {
    const regular = this.readPositiveHours('SYNTHESIZE_ANSWER_CACHE_TTL_HOURS', '24', 24);
    if (!shortWindow) return regular;
    const short = this.readPositiveHours('SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS', '1', 1);
    return Math.min(regular, short);
  }

  private readPositiveHours(key: string, dflt: string, fallback: number): number {
    const raw = this.configService.get<string>(key, dflt);
    const v = parseInt(raw ?? dflt, 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Positive-integer env read with a numeric fallback (invalid → fallback). */
  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key, String(fallback));
    const v = parseInt(raw ?? String(fallback), 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
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
      (await this.readPin?.resolveRead(opts.companyId)) ?? ReadPinService.bootstrapRead();
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
      isEnumeration: detectEnumerationShape(normalizedQuery),
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
        `SELECT id, answer, citedFactIds, entityIds, createdAt, expiresAt,
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
   * CHECK-ON-READ — the correctness core. One batch SELECT of (1) the
   * cited facts, (2) their entity names, and (3) the ADDITIVE-WRITE
   * freshness probe — all through the SAME fences the fact read path
   * applies (facts.service.ts loadVisibleFact): user-scope pin via
   * pinUserScope + registry-backed row policy via makeRowPolicyFilter.
   *
   * The entry serves only when EVERY cited fact is still active + valid
   * AND no newer visible fact has appeared on a cited entity since the
   * answer was built. Fail-closed on both axes: a cited fact that is
   * absent OR fenced away is 'missing' (existence never leaks); a newer
   * scope+policy-visible fact on a cited entity is 'newer_fact' (audit
   * F1 — the additive cat→dog case: the cited 'cat' fact stays active,
   * but a 'dog' fact was added, so the cached answer is stale). Any fence
   * uncertainty is a miss, never a serve.
   */
  private async checkOnRead(
    ctx: AnswerCacheStoreContext,
    row: CacheRow,
    callerScopes: string[],
  ): Promise<{ cause: InvalidationCause } | { citations: Citation[] }> {
    const ids = row.citedFactIds ?? [];
    if (ids.length === 0) return { cause: 'missing' };
    const entityIds = row.entityIds ?? [];
    const answerCreatedAt =
      row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
    // Freshness-probe user gate — mirrors the retrieval where-builder
    // EXACTLY (search/internals/where-builder.ts): a user-scoped answer
    // saw global + its OWN facts; a tenant-global answer saw global only.
    // This DB-level gate (keyed on the answer's ctx.userId partition) is
    // what keeps an M2M answer for user_a immune to a new user_b fact and
    // a global answer immune to any per-user fact — the probe can only
    // fire on a fact the answer's scope would actually have retrieved.
    const probeUserGate = ctx.userId
      ? 'AND (userId IS NONE OR userId = $probeScopeUserId)'
      : 'AND userId IS NONE';
    const { facts, names, newer } = await this.surreal.withScopedCompany(
      ctx.companyId,
      callerScopes,
      async (db) => {
        const [factRows, entityRows, newerRows] = await db.query<
          [CitedFactRow[], Array<{ id: unknown; canonicalName: string }>, CitedFactRow[]]
        >(
          `SELECT id, predicate, object, entityId, status, validUntil,
                  retractedAt, userId, source, trustSnapshot, corroboration
             FROM knowledge_fact WHERE id INSIDE $ids;
           SELECT id, canonicalName FROM knowledge_entity
            WHERE id INSIDE $entityIds;
           SELECT id, predicate, object, entityId, status, userId, source,
                  trustSnapshot, corroboration
             FROM knowledge_fact
            WHERE entityId INSIDE $entityIds
              AND status = 'active'
              AND recordedAt > $answerCreatedAt
              ${probeUserGate}
            LIMIT ${FRESHNESS_PROBE_CAP + 1}`,
          {
            ids: ids.map((id) => new StringRecordId(id)),
            entityIds: entityIds.map((id) => new StringRecordId(id)),
            answerCreatedAt,
            ...(ctx.userId ? { probeScopeUserId: ctx.userId } : {}),
          },
        );
        return {
          facts: factRows ?? [],
          names: entityRows ?? [],
          newer: newerRows ?? [],
        };
      },
    );
    const byId = new Map(facts.map((f) => [String(f.id), f]));
    const nameById = new Map(names.map((e) => [String(e.id), e.canonicalName]));
    // Same user-scope semantics as loadVisibleFact: a user-bound token
    // sees tenant-global facts + its own; M2M (no pinned user) sees all.
    const scopeUserId = pinUserScope(undefined);
    const rowPolicy = makeRowPolicyFilter({
      callerScopes,
      surface: 'answer_cache_read',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(ctx.companyId),
    });
    const fences: ReadFences = { scopeUserId, rowPolicy };
    const cited = this.evaluateCitedFacts(ids, { byId, nameById }, fences);
    // Additive-write freshness probe (audit F1) runs ONLY when every cited
    // fact still validated — a more specific lifecycle cause
    // (retracted/superseded/…) takes precedence over 'newer_fact' for
    // observability. A newer visible fact on a cited entity means the
    // store changed under this answer: fail closed to a fresh synthesis.
    const result: { cause: InvalidationCause } | { citations: Citation[] } =
      'cause' in cited
        ? cited
        : this.hasNewerVisibleFact(newer, fences)
          ? { cause: 'newer_fact' }
          : cited;
    rowPolicy.finish();
    return result;
  }

  /**
   * Per-cited-fact lifecycle gate (extracted from checkOnRead). Every
   * cited fact must be visible under the user-scope + row-policy fences
   * AND still `active` inside its validity window; the FIRST failure
   * returns its cause, fail-closed. On success the citations are rebuilt
   * from the LIVE fact rows.
   */
  private evaluateCitedFacts(
    ids: string[],
    lookups: { byId: Map<string, CitedFactRow>; nameById: Map<string, string> },
    fences: ReadFences,
  ): { cause: InvalidationCause } | { citations: Citation[] } {
    const { byId, nameById } = lookups;
    const { scopeUserId, rowPolicy } = fences;
    const citations: Citation[] = [];
    for (const id of ids) {
      const fact = byId.get(id);
      if (!fact) return { cause: 'missing' };
      // fenced/denied = absent (existence never leaks to a caller).
      if (this.fencedAway(fact, scopeUserId) || !rowPolicy.filter(fact)) {
        return { cause: 'missing' };
      }
      if (fact.status === 'retracted' || fact.retractedAt) return { cause: 'retracted' };
      if (fact.status === 'superseded') return { cause: 'superseded' };
      // competing/compacted — left the servable lifecycle state; fail closed.
      if (fact.status !== 'active') return { cause: 'missing' };
      if (fact.validUntil && toMs(fact.validUntil) <= Date.now()) {
        return { cause: 'expired_validity' };
      }
      citations.push({
        factId: id,
        entityId: String(fact.entityId ?? ''),
        canonicalName: nameById.get(String(fact.entityId ?? '')) ?? '',
        predicate: fact.predicate,
        object: fact.object,
      });
    }
    return { citations };
  }

  /**
   * Additive-write freshness probe (audit F1): true when at least one
   * candidate newer fact on a cited entity survives the SAME JS-side
   * fences the cited-fact re-check applies (user-scope pin + row policy).
   * The DB query already scoped candidates to the answer's user partition
   * (in SQL) and to recordedAt newer than the answer's createdAt.
   *
   * Gap-1 overflow guard (fail-closed): the DB fetched FRESHNESS_PROBE_CAP
   * + 1 candidates. The ABAC row policy + predicate-scope gate can only be
   * evaluated here, in JS, AFTER that DB LIMIT — so if the DB returned a
   * FULL page (> cap rows), more newer facts exist on the cited entities
   * than we can scope-check, and a row-policy-VISIBLE newer fact could sit
   * beyond the cap where the fences never reached it. We cannot prove
   * freshness, so we invalidate. This is what stops the cap from ever
   * HIDING a visible newer fact behind a crowd of fenced-away rows: a full
   * page is itself the additive-write signal. Under the cap the page is
   * exhaustive, so the per-row visible check below is exact.
   */
  private hasNewerVisibleFact(newer: CitedFactRow[], fences: ReadFences): boolean {
    if (newer.length > FRESHNESS_PROBE_CAP) return true; // full page — fail closed
    for (const f of newer) {
      if (this.fencedAway(f, fences.scopeUserId)) continue; // invisible to this caller
      if (!fences.rowPolicy.filter(f)) continue; // policy-denied — caller can't see it
      return true;
    }
    return false;
  }

  /**
   * Shared user-scope fence (loadVisibleFact semantics): a fact bound to
   * ANOTHER user is invisible — existence never leaks. M2M (scopeUserId
   * undefined) sees all. Used by both the cited-fact check and the probe.
   */
  private fencedAway(fact: { userId?: string | null }, scopeUserId: string | undefined): boolean {
    return (
      scopeUserId !== undefined &&
      typeof fact.userId === 'string' &&
      fact.userId.length > 0 &&
      fact.userId !== scopeUserId
    );
  }

  private async invalidate(ctx: AnswerCacheStoreContext, cause: InvalidationCause): Promise<void> {
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
