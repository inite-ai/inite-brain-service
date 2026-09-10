import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { pinUserScope } from '../auth/user-scope';
import { makeRowPolicyFilter, type RowPolicyFilter } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { MetricsService } from '../metrics/metrics.service';
import { ReadPinService, type ReadPin } from '../episodes/read-pin.service';
import { detectEnumerationShape } from '../synthesize/answer-router';
import { hasCurrentModalityConsent, type ModalityConsentRow } from '../ai/domain-packs';
import {
  beliefLaneVisible,
  beliefStamp,
  episodeStamp,
  episodeVisible,
  fragmentStamp,
  fragmentVisible,
  sceneStamp,
  sceneVisible,
  type EvidenceFences,
  type EvidenceWorldState,
} from '../synthesize/evidence-visibility';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeDto } from '../synthesize/dto/synthesize.dto';
import type { EvidenceCitation, SynthesizeResult } from '../synthesize/synthesize.types';
import type { Citation } from '../synthesize/fact-index';

/**
 * Generator/verifier PROMPT SHAPE version baked into the cache key.
 * The stored answer is a function of the prompt assembly, not only of
 * the evidence: a change to the generator system prompt, the fact-line
 * rendering, or the frame sections can change what the same facts
 * produce — and none of that is visible in the profile or the model
 * id. Bump this constant MANUALLY in the PR that changes prompt shape OR
 * the stored-row contract; every existing entry then misses by key
 * construction (no sweep needed, TTL reaps the orphans).
 *
 *   1 — 0091 shape.
 *   2 — 0136: a row carries its typed non-fact `dependencies`; a pre-0136
 *       row cannot be revalidated and must never be served.
 */
export const ANSWER_CACHE_PROMPT_VERSION = 2;

/** Table + record-id namespace of the cache rows (migration 0091). */
const TABLE = 'answer_cache';

/** Mirrors the migration-0091/0097/0136 ASSERT on
 *  answer_cache.invalidationCause. `newer_fact` (0097) = the additive-write
 *  freshness cause: a NEW active fact appeared on a cited entity after the
 *  answer was built. `dependency_changed` (0136) = a non-fact dependency's
 *  lifecycle stamp moved while its row stayed servable (a belief revised in
 *  place, a scene recomposed, an asset's quarantine state changed). */
export type InvalidationCause =
  'superseded' | 'retracted' | 'expired_validity' | 'missing' | 'newer_fact' | 'dependency_changed';

/**
 * The non-fact evidence a cached answer rests on (0136, audit F3) — one
 * entry per EvidenceCitation arm, in the order the arms are declared.
 * Every kind here is revalidated on EVERY read; an arm this list does not
 * name is untrackable, and an answer citing one is never admitted.
 */
export type CachedDependencyKind = 'belief' | 'episode' | 'fragment' | 'scene';

export interface CachedDependency {
  kind: CachedDependencyKind;
  /** Full record id — `semantic_belief:…`, `episode:…`,
   *  `evidence_fragment:…`, `memory_episode:…`. */
  id: string;
  /**
   * Lifecycle stamp observed at admission, compared byte-for-byte on
   * read: a belief's `revision`, a scene's gist hash, a fragment's asset
   * quarantine state; '' for an episode (immutable text — existence IS
   * its lifecycle). A changed stamp is `dependency_changed`.
   */
  rev: string;
}

const DEPENDENCY_KINDS: readonly CachedDependencyKind[] = [
  'belief',
  'episode',
  'fragment',
  'scene',
];

/** A dependency row as the per-kind SELECT returns it (see dependencySelect). */
interface DependencyRow {
  id: unknown;
  userId?: string | null;
  revision?: number | string | null;
  status?: string | null;
  supersededBy?: unknown;
  validUntil?: Date | string | null;
  quarantineStatus?: string | null;
  gist?: string | null;
  enrichedGist?: string | null;
  unexpectedDetails?: unknown;
  /** Visibility-fence columns — see the per-kind predicates in
   *  synthesize/evidence-visibility.ts. */
  userIds?: unknown;
  piiClass?: unknown;
  piiClasses?: unknown;
  segmenterVersion?: unknown;
  assetUserId?: unknown;
  assetAvailability?: unknown;
}

/**
 * The typed dependency set of a result's evidence citations, or null when
 * a citation carries no arm this cache can revalidate (the ONE-OF
 * invariant means exactly one id is present on a well-formed citation;
 * a malformed one is untrackable and blocks admission — fail closed).
 * De-duplicated per (kind, id); kind order is the declared arm order.
 */
export function dependenciesOf(
  evidenceCitations: EvidenceCitation[] | undefined,
): Array<Pick<CachedDependency, 'kind' | 'id'>> | null {
  const out: Array<Pick<CachedDependency, 'kind' | 'id'>> = [];
  const seen = new Set<string>();
  for (const c of evidenceCitations ?? []) {
    const dep = dependencyArm(c);
    if (!dep) return null;
    const key = `${dep.kind}|${dep.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out.sort((a, b) => DEPENDENCY_KINDS.indexOf(a.kind) - DEPENDENCY_KINDS.indexOf(b.kind));
}

function dependencyArm(c: EvidenceCitation): Pick<CachedDependency, 'kind' | 'id'> | null {
  if (isRecordId(c.beliefId)) return { kind: 'belief', id: c.beliefId };
  if (isRecordId(c.episodeId)) return { kind: 'episode', id: c.episodeId };
  if (isRecordId(c.fragmentId)) return { kind: 'fragment', id: c.fragmentId };
  if (isRecordId(c.sceneId)) return { kind: 'scene', id: c.sceneId };
  return null;
}

/** 3.x does not coerce string↔record: only a `table:key` string can be
 *  bound as a record id, so anything else is untrackable. */
function isRecordId(v: unknown): v is string {
  return typeof v === 'string' && v.includes(':') && v.length > 2;
}

/** The id-only evidence citation a served hit returns for a dependency —
 *  the arm the answer was admitted with, nothing rendered. */
function citationOfDependency(dep: CachedDependency): EvidenceCitation {
  switch (dep.kind) {
    case 'belief':
      return { beliefId: dep.id };
    case 'episode':
      return { episodeId: dep.id };
    case 'fragment':
      return { fragmentId: dep.id };
    case 'scene':
      return { sceneId: dep.id };
  }
}

/** A stored dependency entry as the 0136 ASSERTs shape it; anything else
 *  is a malformed row and fails closed on read. */
function isCachedDependency(v: unknown): v is CachedDependency {
  if (v === null || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.kind === 'string' &&
    (DEPENDENCY_KINDS as readonly string[]).includes(d.kind) &&
    isRecordId(d.id) &&
    typeof d.rev === 'string'
  );
}

/**
 * One SELECT per kind, bound on `$<kind>` (a record-id array). The
 * projection is exactly what `dependencyRev` and `dependencyLifecycle`
 * read PLUS every column the serving lane's visibility fence reads
 * (round-2 audit F1): the stamp alone said nothing about media PII,
 * modality consent, asset ownership, availability, text PII, scene
 * membership or the live scene world, so re-checking only the stamp
 * served closed evidence to a key that never held the scope. Nothing
 * content-bearing leaves the DB — piiClasses/piiClass are
 * classifications, not content.
 */
function dependencySelect(kind: CachedDependencyKind): string {
  switch (kind) {
    case 'belief':
      return `SELECT id, revision, status, supersededBy, validUntil, userId
                FROM semantic_belief WHERE id INSIDE $belief`;
    case 'episode':
      return `SELECT id, userId, piiClass FROM episode WHERE id INSIDE $episode`;
    case 'fragment':
      // The fragment row is immutable; its parent asset's quarantine
      // state is the lifecycle (a rejected asset must not keep serving
      // through a cached answer). A dangling asset link reads as NONE.
      return `SELECT id, piiClasses,
                     assetId.quarantineStatus AS quarantineStatus,
                     assetId.userId AS assetUserId,
                     assetId.availability AS assetAvailability
                FROM evidence_fragment WHERE id INSIDE $fragment`;
    case 'scene':
      return `SELECT id, gist, enrichedGist, unexpectedDetails, userId, userIds,
                     piiClass, segmenterVersion
                FROM memory_episode WHERE id INSIDE $scene`;
  }
}

/** The stamp that must not move for the cached answer to stay valid —
 *  the SAME functions the serving lanes stamp their rendered rows with. */
function dependencyRev(kind: CachedDependencyKind, row: DependencyRow): string {
  switch (kind) {
    case 'belief':
      return beliefStamp(row);
    case 'episode':
      return episodeStamp();
    case 'fragment':
      return fragmentStamp(row);
    case 'scene':
      return sceneStamp(row);
  }
}

/** Kinds whose stamp can move under a running request — the ones the
 *  retrieval snapshot has to cover (round-2 audit F4). An episode's text
 *  is immutable, so its stamp is constant and needs no snapshot. */
const MUTABLE_DEPENDENCY_KINDS: readonly CachedDependencyKind[] = ['belief', 'fragment', 'scene'];

/**
 * The serving lane's OWN per-row visibility fence, re-applied to a
 * dependency row (round-2 audit F1). False = invisible to this caller,
 * which reads as 'missing' — existence never leaks. This is the half a
 * lifecycle stamp cannot carry: revoking modality consent, reclassifying
 * a fragment's piiClasses, stamping a scene's piiClass, promoting a new
 * scene world or erasing an asset's bytes all leave every stamp intact.
 */
function dependencyVisible(
  kind: CachedDependencyKind,
  row: DependencyRow,
  fences: EvidenceFences,
): boolean {
  const { caller, world } = fences;
  switch (kind) {
    case 'belief':
      return beliefLaneVisible(row, caller);
    case 'episode':
      return episodeVisible(row, caller);
    case 'fragment':
      return fragmentVisible(row, caller, world);
    case 'scene':
      return sceneVisible(row, caller, world);
  }
}

/**
 * The lifecycle gate a dependency row must pass to be servable — the
 * cited-fact gate's counterpart per kind. Null = servable. The scope
 * fences live in `dependencyVisible`, which runs first.
 *
 * A belief never reads 'retracted': migration 0120 asserts
 * `status INSIDE ['active','superseded']`, so retraction is not a state a
 * belief can reach (a value change is a new revision). The cause stays in
 * the typed union because a retracted cited FACT still emits it.
 */
function dependencyLifecycle(
  kind: CachedDependencyKind,
  row: DependencyRow,
): InvalidationCause | null {
  if (kind === 'belief') {
    if (
      row.status === 'superseded' ||
      (row.supersededBy !== undefined && row.supersededBy !== null)
    ) {
      return 'superseded';
    }
    if (row.status !== 'active') return 'missing';
    if (row.validUntil && toMs(row.validUntil) <= Date.now()) return 'expired_validity';
  }
  if (kind === 'fragment' && row.quarantineStatus === 'rejected') return 'missing';
  return null;
}

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

/**
 * Hash of the caller's EFFECTIVE scope set (round-2 audit F1, half b):
 * two keys of the same tenant and user but different rights must never
 * share an entry. Order- and duplicate-insensitive so the same rights
 * always produce the same partition. This is the cheap half of the fix —
 * the load-bearing half is re-applying each lane's visibility fence on
 * every hit (dependencyVisible), because the same key's own rights can be
 * narrowed after admission by a consent revocation or a reclassification.
 */
export function computeScopeHash(callerScopes: readonly string[]): string {
  return sha256([...new Set(callerScopes)].sort().join(' '));
}

export interface AnswerCacheKeyInput {
  companyId: string;
  /** Pinned end-user scope; undefined = tenant-global (M2M). */
  userId?: string | undefined;
  profileHash: string;
  model: string;
  derivedVersionPin: ReadPin;
  /** computeScopeHash of the caller's effective scope set. */
  scopeHash: string;
  query: string;
}

/** SHA256 of `companyId|userId or '-'|scopeHash|profileHash|model|
 *  promptVersion|derivedVersionPin|normalized(query)` — the row's
 *  queryHash AND its record id (idempotent admission via UPSERT on the
 *  same id). */
export function computeCacheKey(input: AnswerCacheKeyInput): string {
  return sha256(
    [
      input.companyId,
      input.userId ?? '-',
      input.scopeHash,
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
  /** The request's effective scope set — admission re-applies each lane's
   *  visibility fence with it, exactly as a hit does. */
  callerScopes: readonly string[];
  profileHash: string;
  model: string;
  normalizedQuery: string;
  /** Open-enumeration query shape ("list all X" / counting / ordering) —
   *  admit() keys a shorter TTL on it (additive writes on NOT-yet-cited
   *  entities escape the entity-scoped freshness probe). */
  isEnumeration: boolean;
  /**
   * Lifecycle stamps of everything the LANES RENDERED for this request,
   * keyed `kind|id`, recorded by observeRendered() right after retrieval
   * (round-2 audit F4). admit() compares them with the live stamps and
   * refuses to cache when any of them moved while the generator ran —
   * otherwise a Monday answer is stored under Tuesday's hash and the next
   * hit validates it. Absent = no observation was made (bare-cache
   * callers, unit fixtures): admission then stamps from the live rows, as
   * it did before.
   */
  renderedStamps?: ReadonlyMap<string, string> | undefined;
}

/** One rendered evidence item, as observeRendered reads it. */
interface StampedRendered {
  stamp?: string | undefined;
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
  /** 0136 typed non-fact dependencies; absent on a pre-0136 row, which
   *  therefore cannot be revalidated and fails closed. */
  dependencies?: CachedDependency[] | null;
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
 * Every dependency, not only the facts (0136, audit F3): a mixed answer
 * — facts plus belief / episode / fragment / scene citations — stores
 * its non-fact arms as typed {kind, id, rev} entries stamped from the
 * live rows at admission, and check-on-read revalidates each one:
 * missing or fenced ⇒ 'missing', a belief superseded / past validUntil ⇒
 * its lifecycle cause, a moved stamp (belief revision, scene content,
 * asset quarantine state) ⇒ 'dependency_changed'. An answer whose
 * evidence the cache cannot track is not admitted; a pre-0136 row (no
 * dependency list) is never served.
 *
 * The FENCE, not only the stamp (round-2 audit F1): a lifecycle stamp
 * carries nothing about the caller's RIGHTS, so re-checking it alone let
 * a `brain:read` key read a closed media fragment out of an entry a
 * `brain:read_media` key had admitted — same tenant, same user, same
 * key. The scoped DB connection does not help (its system user bypasses
 * table and field PERMISSIONS), so every hit now re-applies the SERVING
 * LANE'S OWN visibility predicate per dependency — media PII, modality
 * consent, asset ownership and availability for a fragment; the member
 * gate, text PII and the live scene world for a scene; text PII and
 * ownership for an episode; ownership for a belief — from one shared
 * module (synthesize/evidence-visibility.ts) the lanes themselves call.
 * The caller's effective scope set additionally partitions the KEY, so
 * differently-privileged keys cannot share an entry at all; the fence is
 * still the load-bearing half, because the same key's own rights narrow
 * whenever consent is revoked or evidence reclassified.
 *
 * The stamp is the RETRIEVAL-time one (round-2 audit F4): the lanes stamp
 * what they rendered, observeRendered() records it, and admission refuses
 * to cache when the live row has moved since — otherwise an answer built
 * from Monday's scene was stored under Tuesday's hash and the next hit
 * validated Monday's text.
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
   * Evidence citations are admission-bearing ONLY as tracked dependencies
   * (0136, audit F3). Fact citations remain the admission gate — an
   * answer with zero fact citations (episode-only L3, belief-only
   * current-state) has citations.length 0 and is rejected below, since
   * the entity-scoped freshness probe has nothing to anchor on. A MIXED
   * answer (≥1 fact plus belief / episode / fragment / scene citations)
   * used to be admitted with only its fact half recorded, so a belief
   * revision left the cached text serving until TTL; it is now admitted
   * with every non-fact arm stored as {kind, id, rev} and revalidated on
   * read, and it is NOT admitted at all when any arm is untrackable or
   * already dead at admission time (fail closed — the answer is stale
   * before it is stored).
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
    const wanted = dependenciesOf(result.evidenceCitations);
    if (wanted === null) {
      // A citation with no trackable arm — the cache cannot promise to
      // notice when it dies, so the answer is served fresh every time.
      this.metrics?.countAnswerCache('not_admitted');
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
      const stored = await this.surreal.withCompany(ctx.companyId, async (db) => {
        // Stamp every non-fact dependency from its LIVE row first: the
        // revision the answer was built against is what the read path
        // compares to. A dependency that is already missing, fenced, or
        // dead at admission means the answer is stale before it is
        // stored — never written (fail closed).
        const dependencies = await this.stampDependencies(db, wanted, ctx);
        if (dependencies === null) return false;
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
             dependencies: $dependencies,
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
            dependencies,
            profileHash: ctx.profileHash,
            modelId: ctx.model,
            promptVersion: ANSWER_CACHE_PROMPT_VERSION,
            expiresAt,
          },
        );
        return true;
      });
      this.metrics?.countAnswerCache(stored ? 'stored' : 'not_admitted');
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
      callerScopes: string[];
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
    // Rights partition the key (round-2 audit F1, half b): a
    // `brain:read_media` answer and a `brain:read` answer to the same
    // question are different answers, so they can never share an entry.
    const scopeHash = computeScopeHash(opts.callerScopes);
    return {
      key: computeCacheKey({
        companyId: opts.companyId,
        userId,
        scopeHash,
        profileHash,
        model: opts.model,
        derivedVersionPin,
        query: normalizedQuery,
      }),
      companyId: opts.companyId,
      userId,
      callerScopes: opts.callerScopes,
      profileHash,
      model: opts.model,
      normalizedQuery,
      isEnumeration: detectEnumerationShape(normalizedQuery),
    };
  }

  /**
   * Record the retrieval-time lifecycle stamps of everything the serving
   * lanes RENDERED into this request's prompt (round-2 audit F4). Call it
   * once, right after evidence collection, with the lanes' rendered-set
   * maps; admission then compares each cited dependency against the state
   * the GENERATOR saw rather than against whatever the row has become,
   * and refuses to cache on a mismatch. Cheap and pure — the stamps were
   * computed by the lanes from rows already in memory. An absent ctx (the
   * cache served a hit, or is off) is a no-op, so the caller needs no
   * branch of its own.
   */
  observeRendered(
    ctx: AnswerCacheStoreContext | undefined,
    rendered: {
      belief?: ReadonlyMap<string, StampedRendered> | undefined;
      fragment?: ReadonlyMap<string, StampedRendered> | undefined;
      scene?: ReadonlyMap<string, StampedRendered> | undefined;
    },
  ): void {
    if (!ctx) return;
    const stamps = new Map<string, string>();
    const kinds: Array<[CachedDependencyKind, ReadonlyMap<string, StampedRendered> | undefined]> = [
      ['belief', rendered.belief],
      ['fragment', rendered.fragment],
      ['scene', rendered.scene],
    ];
    for (const [kind, map] of kinds) {
      for (const [id, item] of map ?? []) {
        if (typeof item.stamp === 'string') stamps.set(`${kind}|${id}`, item.stamp);
      }
    }
    ctx.renderedStamps = stamps;
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
        `SELECT id, answer, citedFactIds, entityIds, dependencies, createdAt,
                expiresAt, invalidatedAt
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
    // 0136: the non-fact arms the answer rests on, just revalidated, come
    // back as id-only evidence citations (the rendered excerpt is not
    // stored); absent when there are none, per the SynthesizeResult
    // contract.
    const evidenceCitations = (row.dependencies ?? []).map(citationOfDependency);
    return {
      answer: row.answer,
      citations: verdict.citations,
      ...(evidenceCitations.length > 0 ? { evidenceCitations } : {}),
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
    // 0136: a pre-0136 row carries no dependency list, so what it rests on
    // beyond its cited facts is unknown — fail closed (the key-version
    // bump already makes such a row miss; this is the belt to that brace).
    const dependencies = row.dependencies;
    if (!Array.isArray(dependencies)) return { cause: 'missing' };
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
    const trackable = dependencies.filter(isCachedDependency);
    const { facts, names, newer, dependencyRows, world } = await this.surreal.withScopedCompany(
      ctx.companyId,
      callerScopes,
      async (db) => {
        // 0136: the non-fact dependencies' live rows, on the SAME scoped
        // connection (one extra round trip only when the row has any),
        // plus the tenant-level fence state those rows are judged against.
        const world = await this.fetchWorldState(db, trackable);
        const dependencyRows = await this.fetchDependencyRows(db, dependencies);
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
          dependencyRows,
          world,
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
    // Precedence, most specific first: a dead cited fact, then a dead or
    // changed non-fact dependency (0136), then the additive-write freshness
    // probe (audit F1) — which runs ONLY when everything the answer rests
    // on still validated, so a lifecycle cause is never masked by
    // 'newer_fact'. Any of them means the store changed under this
    // answer: fail closed to a fresh synthesis.
    let result: { cause: InvalidationCause } | { citations: Citation[] } = cited;
    if (!('cause' in result)) {
      // The dependency fences use the answer's OWN pinned user scope (the
      // one the lanes read with and admission stamped against), not the
      // ambient token scope the fact fences use.
      const depFences: EvidenceFences = { caller: { callerScopes, userId: ctx.userId }, world };
      const dependencyCause = this.evaluateDependencies(dependencies, dependencyRows, depFences);
      if (dependencyCause) result = { cause: dependencyCause };
      else if (this.hasNewerVisibleFact(newer, fences)) result = { cause: 'newer_fact' };
    }
    rowPolicy.finish();
    return result;
  }

  /**
   * Admission-time stamping (0136): every wanted dependency's LIVE row,
   * read on the connection the cache row is written with. Null — the
   * answer is not cached at all — when any dependency is missing, fails
   * its serving lane's visibility fence for THIS caller, is already dead,
   * or has MOVED since retrieval.
   *
   * That last clause is round-2 audit F4. The live row is read after
   * generation and verification, so stamping it blindly pinned an answer
   * built from Monday's scene to Tuesday's hash, and the next hit passed
   * the stamp check and served Monday's text. The retrieval snapshot
   * (ctx.renderedStamps, recorded by observeRendered) is the state the
   * generator actually saw: a mutable dependency missing from it, or
   * carrying a different stamp, means the store moved under this answer —
   * refuse to cache and let the next request re-synthesize.
   */
  private async stampDependencies(
    db: Pick<Surreal, 'query'>,
    wanted: ReadonlyArray<Pick<CachedDependency, 'kind' | 'id'>>,
    ctx: AnswerCacheStoreContext,
  ): Promise<CachedDependency[] | null> {
    if (wanted.length === 0) return [];
    const fences: EvidenceFences = {
      caller: { callerScopes: ctx.callerScopes, userId: ctx.userId },
      world: await this.fetchWorldState(db, wanted),
    };
    const rows = await this.fetchDependencyRows(db, wanted);
    const snapshot = ctx.renderedStamps;
    const out: CachedDependency[] = [];
    for (const dep of wanted) {
      const row = rows.get(`${dep.kind}|${dep.id}`);
      if (!row) return null;
      if (!dependencyVisible(dep.kind, row, fences)) return null;
      if (dependencyLifecycle(dep.kind, row) !== null) return null;
      const rev = dependencyRev(dep.kind, row);
      if (snapshot && MUTABLE_DEPENDENCY_KINDS.includes(dep.kind)) {
        const observed = snapshot.get(`${dep.kind}|${dep.id}`);
        if (observed === undefined || observed !== rev) return null;
      }
      out.push({ kind: dep.kind, id: dep.id, rev });
    }
    return out;
  }

  /**
   * The tenant-level state the dependency fences read, fetched once per
   * dependency batch and ONLY for the kinds present: the world the
   * projection registry marks live for `scenes` (a scene demoted to
   * 'residual' by a promotion keeps its rows and every stamp, so this is
   * the only thing that closes it) and whether the tenant still holds
   * current non-text modality consent (0112 — a revocation must close a
   * cached media answer too). No fragment or scene arm ⇒ no query.
   */
  private async fetchWorldState(
    db: Pick<Surreal, 'query'>,
    deps: ReadonlyArray<Pick<CachedDependency, 'kind' | 'id'>>,
  ): Promise<EvidenceWorldState> {
    const needsScene = deps.some((d) => d.kind === 'scene');
    const needsMedia = deps.some((d) => d.kind === 'fragment');
    if (!needsScene && !needsMedia) return { sceneWorld: null, mediaConsent: false };
    const statements: string[] = [];
    if (needsScene) {
      statements.push(`SELECT VALUE version FROM projection
            WHERE name = 'scenes' AND status = 'live'
            ORDER BY finishedAt DESC
            LIMIT 1;`);
    }
    if (needsMedia) {
      statements.push(
        // ACTIVE installs only, exactly as the fragment lane reads it:
        // uninstall keeps the row (status = 'removed') with its manifest
        // and checksum, so a removed pack must not go on consenting.
        `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum FROM domain_pack
            WHERE status = 'active';`,
      );
    }
    const results = await db.query<unknown[]>(statements.join('\n'));
    let cursor = 0;
    let sceneWorld: string | null = null;
    if (needsScene) {
      const worlds = (results[cursor++] ?? []) as unknown[];
      const first = worlds[0];
      sceneWorld = typeof first === 'string' && first !== '' ? first : null;
    }
    let mediaConsent = false;
    if (needsMedia) {
      const packs = (results[cursor++] ?? []) as ModalityConsentRow[];
      mediaConsent = hasCurrentModalityConsent(packs);
    }
    return { sceneWorld, mediaConsent };
  }

  /**
   * The live rows behind a dependency set — one SELECT per kind present,
   * one round trip, keyed `kind|id`. Empty input ⇒ no query at all, so a
   * fact-only answer costs exactly what it did before 0136.
   */
  private async fetchDependencyRows(
    db: Pick<Surreal, 'query'>,
    deps: ReadonlyArray<Pick<CachedDependency, 'kind' | 'id'>>,
  ): Promise<Map<string, DependencyRow>> {
    const out = new Map<string, DependencyRow>();
    const kinds = DEPENDENCY_KINDS.filter((k) => deps.some((d) => d.kind === k));
    if (kinds.length === 0) return out;
    const params: Record<string, StringRecordId[]> = {};
    for (const k of kinds) {
      params[k] = deps
        .filter((d) => d.kind === k && isRecordId(d.id))
        .map((d) => new StringRecordId(d.id));
    }
    const results = await db.query<DependencyRow[][]>(
      kinds.map((k) => `${dependencySelect(k)};`).join('\n'),
      params,
    );
    kinds.forEach((k, i) => {
      for (const r of results[i] ?? []) out.set(`${k}|${String(r.id)}`, r);
    });
    return out;
  }

  /**
   * Read-time gate over the stored dependency list (0136): every entry
   * must still pass its serving lane's OWN visibility fence for this
   * caller, pass its kind's lifecycle gate, and carry the SAME revision
   * stamp it was admitted with. The FIRST failure returns its cause,
   * fail-closed; a malformed stored entry reads as 'missing'.
   */
  private evaluateDependencies(
    deps: ReadonlyArray<unknown>,
    rows: ReadonlyMap<string, DependencyRow>,
    fences: EvidenceFences,
  ): InvalidationCause | null {
    for (const raw of deps) {
      if (!isCachedDependency(raw)) return 'missing';
      const row = rows.get(`${raw.kind}|${raw.id}`);
      if (!row) return 'missing';
      // The serving lane's own fence first: invisible reads as 'missing',
      // so a caller who could not be served this evidence FRESH cannot
      // read it out of a cached answer either (round-2 audit F1).
      if (!dependencyVisible(raw.kind, row, fences)) return 'missing';
      const cause = dependencyLifecycle(raw.kind, row);
      if (cause) return cause;
      if (dependencyRev(raw.kind, row) !== raw.rev) return 'dependency_changed';
    }
    return null;
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
