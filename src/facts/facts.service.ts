import { ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService, dbMerge } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { EpisodeReadStoreService } from '../episodes/episode-read-store.service';
import { RetractFactDto } from './dto/retract.dto';
import { BrainScope } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import {
  makeRowPolicyFilter,
  type PolicyFilterableRow,
} from '../policy/row-filter';
import { activeFactWhere } from '../entities/entity-read.helpers';

/**
 * Predicate-class allowlist that requires `brain:admin` for retract,
 * not just `brain:write`. Retracting a fact in any of these classes
 * cascades — `billing_event` rows reach downstream invoicing audits,
 * `human_declared` rows represent operator-attested ground truth, and
 * anything emitted by `source.kind === 'legal'` is regulator-visible.
 * A leaked write-only key shouldn't be able to delete-by-cascade
 * across those surfaces.
 */
export const RETRACT_ADMIN_PREDICATES = new Set<string>([
  'billing_event',
  'human_declared',
]);

function retractRequiresAdmin(fact: {
  predicate?: unknown;
  source?: unknown;
}): boolean {
  const predicate = typeof fact.predicate === 'string' ? fact.predicate : '';
  if (RETRACT_ADMIN_PREDICATES.has(predicate)) return true;
  const source = fact.source as { kind?: unknown } | undefined;
  if (source && typeof source.kind === 'string' && source.kind === 'legal') {
    return true;
  }
  return false;
}

export interface RetractResult {
  factId: string;
  retractedAt: string;
  cascadedFactIds: string[];
  /**
   * Facts that were previously superseded by the retracted fact and
   * have now been brought back to status='active'. Empty when the
   * retracted fact never superseded anything, or when every
   * predecessor was itself separately retracted (we don't revive a
   * row that was explicitly retracted on its own merits).
   */
  revivedFactIds: string[];
}

export interface CompetingFactRecord {
  factId: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  source?: unknown;
}

export interface CompetingFactGroup {
  /** Composite key — `${entityId}::${predicate}` for callers to merge groups. */
  key: string;
  entityId: string;
  predicate: string;
  facts: CompetingFactRecord[];
}

export interface RetractOptions {
  companyId: string;
  factId: string;
  dto: RetractFactDto;
  callerScopes?: ReadonlyArray<BrainScope>;
}

/**
 * Per-episode text budget of the provenance surface. Mirrors the
 * assistant-lane practice (ASSISTANT_LINE_CHAR_CAP in
 * synthesize/episode-lane.service.ts): a turn can be up to 16K chars at
 * ingest, and provenance is a grounding view, not a transcript export —
 * 600 chars keeps the evidential sentence(s) intact without letting one
 * verbose turn dominate the response.
 */
const PROVENANCE_TEXT_CHAR_CAP = 600;

/**
 * Defensive read of source.charSpans (G3 — written by the derive row
 * builder, but `source` is FLEXIBLE so shapes are never guaranteed).
 * Keeps the first well-formed span per episode; malformed entries are
 * ignored. Only {start, end, exact} go on the wire — prefix/suffix are
 * re-anchoring context for the store, not the API.
 */
function indexCharSpans(
  charSpans: unknown,
): Map<string, { start: number; end: number; exact: string }> {
  const byEpisode = new Map<
    string,
    { start: number; end: number; exact: string }
  >();
  if (!Array.isArray(charSpans)) return byEpisode;
  for (const raw of charSpans) {
    const s = raw as {
      episodeId?: unknown;
      start?: unknown;
      end?: unknown;
      exact?: unknown;
    };
    if (
      typeof s?.episodeId === 'string' &&
      typeof s.start === 'number' &&
      typeof s.end === 'number' &&
      typeof s.exact === 'string' &&
      !byEpisode.has(s.episodeId)
    ) {
      byEpisode.set(s.episodeId, {
        start: s.start,
        end: s.end,
        exact: s.exact,
      });
    }
  }
  return byEpisode;
}

/** Wire shape of GET /v1/facts/:id. */
export interface FactReadResult {
  factId: string;
  /** The fact's predicate — what the memory is ABOUT. */
  aspect: string;
  /** The fact's object — what is remembered. */
  statement: string;
  confidence: number;
  validFrom: string;
  /** Per-user scope key (migration 0055); absent = tenant-global. */
  userId?: string;
  /** source.kind when the deriver stamped one (typed atoms). */
  kind?: string;
  vertical?: string;
  recorder?: string;
  conversationId?: string;
  retracted: boolean;
  derivedVersion?: string;
}

export interface FactProvenanceEpisode {
  episodeId: string;
  conversationId?: string;
  speaker?: string;
  occurredAt: string;
  /** Verbatim turn text, capped at PROVENANCE_TEXT_CHAR_CAP chars. */
  text: string;
  /**
   * G3 char-span grounding quote (source.charSpans, DERIVER_SPANS).
   * Offsets are Unicode CODE POINTS over the NFC-normalized FULL stored
   * episode text — NOT the possibly-truncated `text` field above (see
   * textTruncated) and NOT UTF-16 units.
   */
  span?: { start: number; end: number; exact: string };
  /** Present with `span`: true when `text` was truncated by the cap —
   *  span offsets reference the FULL stored text, not the capped view. */
  textTruncated?: boolean;
}

/** Wire shape of GET /v1/facts/:id/provenance. */
export interface FactProvenanceResult {
  factId: string;
  /** Grounding turns (source.episodeIds), chronological. */
  episodes: FactProvenanceEpisode[];
}

interface FactReadOptions {
  companyId: string;
  factId: string;
  scopes: readonly BrainScope[];
}

/** Row shape loadVisibleFact selects (superset of PolicyFilterableRow). */
interface FactReadRow extends PolicyFilterableRow {
  id: unknown;
  object?: unknown;
  confidence?: unknown;
  validFrom?: unknown;
  retractedAt?: unknown;
  status?: unknown;
  derivedVersion?: unknown;
}

export interface ListCompetingResult {
  entityId: string;
  asOf?: string;
  /**
   * Groups, one per (entityId, predicate). Within a group, every fact
   * was placed at status='competing' by the conflict resolver and is
   * still unretracted at `asOf` (or now if asOf is omitted).
   */
  groups: CompetingFactGroup[];
}

@Injectable()
export class FactsService {
  private readonly logger = new Logger(FactsService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token and cannot be folded into an options object without breaking DI
  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  /**
   * GET /v1/facts/:id — the fact as stored, with its source attribution.
   * Retracted facts still resolve (retracted: true) — "why did I stop
   * remembering this" is part of the trust story; only visibility fences
   * turn into 404s.
   *
   * Fences (each a 404, never a 403 — a 403 would confirm existence):
   *  - tenant: withScopedCompany pins the per-tenant database, same as
   *    retract — a foreign tenant's fact id simply is not present here;
   *  - user scope (0055): via pinUserScope — a user-bound token reads
   *    tenant-global facts and its OWN user-scoped facts; M2M reads all;
   *  - row policy: the registry-backed scope fence + ABAC verdict shared
   *    with the fact lanes (makeRowPolicyFilter) — an operator
   *    scope-fenced predicate is absent to callers without the scope.
   */
  async getFact(opts: FactReadOptions): Promise<FactReadResult> {
    return this.surreal.withScopedCompany(
      opts.companyId,
      opts.scopes,
      async (db) => {
        const fact = await this.loadVisibleFact(db, opts);
        const source = (fact.source ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | undefined =>
          typeof v === 'string' && v.length > 0 ? v : undefined;
        const optional = <K extends string>(
          key: K,
          value: string | undefined,
        ): Partial<Record<K, string>> =>
          value !== undefined ? ({ [key]: value } as Record<K, string>) : {};
        return {
          factId: String(fact.id),
          aspect: fact.predicate,
          statement: String(fact.object ?? ''),
          confidence: typeof fact.confidence === 'number' ? fact.confidence : 0,
          validFrom: toIso(fact.validFrom),
          ...optional('userId', str(fact.userId)),
          ...optional('kind', str(source.kind)),
          ...optional('vertical', str(source.vertical)),
          ...optional('recorder', str(source.recorder)),
          ...optional('conversationId', str(source.conversationId)),
          retracted: Boolean(fact.retractedAt) || fact.status === 'retracted',
          ...optional('derivedVersion', str(fact.derivedVersion)),
        };
      },
    );
  }

  /**
   * GET /v1/facts/:id/provenance — the verbatim turns this fact was
   * derived from ("show me why I remember this"). Episode ids come from
   * the fact's own grounding stamp (source.episodeIds — the same stamp
   * the synthesize lanes read); the rows come from the shared episode
   * read port, so the PII fence and the fail-closed user gate have ONE
   * implementation.
   *
   * Episode user scope: a user-scoped fact's grounding turns carry that
   * user's scope — the caller already passed the fact-level gate, so the
   * fetch is keyed to the FACT's user; a tenant-global fact falls back
   * to the caller's own pinned scope (M2M → tenant-global turns only).
   */
  async getProvenance(opts: FactReadOptions): Promise<FactProvenanceResult> {
    return this.surreal.withScopedCompany(
      opts.companyId,
      opts.scopes,
      async (db) => {
        const fact = await this.loadVisibleFact(db, opts);
        const source = (fact.source ?? {}) as {
          episodeIds?: unknown;
          charSpans?: unknown;
        };
        const spanByEpisode = indexCharSpans(source.charSpans);
        const ids = Array.isArray(source.episodeIds)
          ? [
              ...new Set(
                source.episodeIds
                  .map(String)
                  .filter((e) => e.startsWith('episode:')),
              ),
            ]
          : [];
        if (ids.length === 0) return { factId: String(fact.id), episodes: [] };
        const rows = await this.episodes.byIds({
          companyId: opts.companyId,
          ids,
          includePii: opts.scopes.includes('brain:read_pii'),
          userId:
            typeof fact.userId === 'string' && fact.userId.length > 0
              ? fact.userId
              : pinUserScope(undefined),
          db,
        });
        const episodes = rows
          .slice()
          .sort(
            (a, b) =>
              new Date(toIso(a.occurredAt)).getTime() -
              new Date(toIso(b.occurredAt)).getTime(),
          )
          .map((r): FactProvenanceEpisode => {
            // G3: attach the fact's stored char span for this turn.
            // textTruncated rides along because span offsets reference
            // the FULL stored episode text, not the capped `text` view.
            // Span-less episodes keep the pre-G3 shape byte-identical.
            const span = spanByEpisode.get(String(r.id));
            return {
              episodeId: String(r.id),
              ...(r.conversationId !== undefined
                ? { conversationId: r.conversationId }
                : {}),
              ...(r.speaker !== undefined ? { speaker: r.speaker } : {}),
              occurredAt: toIso(r.occurredAt),
              text:
                r.text.length > PROVENANCE_TEXT_CHAR_CAP
                  ? `${r.text.slice(0, PROVENANCE_TEXT_CHAR_CAP - 1)}…`
                  : r.text,
              ...(span
                ? {
                    span,
                    textTruncated: r.text.length > PROVENANCE_TEXT_CHAR_CAP,
                  }
                : {}),
            };
          });
        return { factId: String(fact.id), episodes };
      },
    );
  }

  /**
   * Fetch one fact row and apply every read fence (user scope + row
   * policy). Shared by getFact and getProvenance so the two endpoints
   * can never disagree on what "visible" means. Throws NotFound on any
   * miss — the caller cannot distinguish "absent" from "fenced".
   */
  private async loadVisibleFact(
    db: Surreal,
    opts: FactReadOptions,
  ): Promise<FactReadRow> {
    const ref = this.normalizeFactId(opts.factId);
    const [rows] = await db.query<[FactReadRow[]]>(
      `SELECT id, predicate, object, confidence, validFrom, validUntil,
              recordedAt, retractedAt, status, source, userId,
              derivedVersion, trustSnapshot, corroboration
         FROM type::record('knowledge_fact', $rid) LIMIT 1`,
      { rid: ref.id },
    );
    const notFound = () =>
      new NotFoundException(`Fact ${opts.factId} not found`);
    const fact = rows?.[0];
    if (!fact) throw notFound();
    // User scope (0055): 404, not 403 — don't leak existence.
    const scopeUserId = pinUserScope(undefined);
    if (
      scopeUserId !== undefined &&
      typeof fact.userId === 'string' &&
      fact.userId.length > 0 &&
      fact.userId !== scopeUserId
    ) {
      throw notFound();
    }
    // Registry-backed row policy (scope fence + ABAC) — same seam as the
    // audit-fixed fact lanes under src/synthesize/.
    const rowPolicy = makeRowPolicyFilter({
      callerScopes: opts.scopes,
      surface: 'fact_read',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(
        opts.companyId,
      ),
    });
    const visible = rowPolicy.filter(fact);
    rowPolicy.finish();
    if (!visible) throw notFound();
    return fact;
  }

  async retract({
    companyId,
    factId,
    dto,
    callerScopes,
  }: RetractOptions): Promise<RetractResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      const ref = this.normalizeFactId(factId);
      const now = new Date();

      // Verify the fact exists and is currently active. SELECT extra
      // predicate + source so the admin-scope gate below can read them,
      // and userId for the ownership fence.
      const [existingRows] = await db.query<any[][]>(
        `SELECT id, status, retractedAt, validFrom, predicate, source,
                userId
           FROM type::record('knowledge_fact', $rid) LIMIT 1`,
        { rid: ref.id },
      );
      const existing = (existingRows as any[])?.[0];
      if (!existing) {
        throw new NotFoundException(`Fact ${factId} not found`);
      }

      // Release blocker (audit 2026-08-21 P0): retract used to mutate
      // with no ownership fence at all — a user-bound brain:write token
      // could retract any fact by id. Same semantics as the read path:
      // another user's fact is a 404 (existence never leaks); a
      // tenant-global fact is retractable by a user-bound token only
      // with brain:admin (it IS readable, so 403 leaks nothing new).
      // In-process legacy callers run outside a request context, where
      // pinUserScope(undefined) is undefined → unrestricted, as before.
      const retractUserScope = pinUserScope(undefined);
      if (retractUserScope !== undefined) {
        const owner =
          typeof existing.userId === 'string' && existing.userId.length > 0
            ? existing.userId
            : undefined;
        if (owner !== undefined && owner !== retractUserScope) {
          throw new NotFoundException(`Fact ${factId} not found`);
        }
        if (owner === undefined && !callerScopes?.includes('brain:admin')) {
          throw new ForbiddenException(
            'retract of a tenant-global fact requires an M2M token or brain:admin',
          );
        }
      }

      // Registry-backed row policy — a predicate the caller cannot see
      // is a predicate the caller cannot retract (404, same as read).
      if (callerScopes) {
        const rowPolicy = makeRowPolicyFilter({
          callerScopes,
          surface: 'fact_read',
          policyLookup: await this.predicateRegistry?.rowPolicyLookup(
            companyId,
          ),
        });
        const visible = rowPolicy.filter(existing);
        rowPolicy.finish();
        if (!visible) {
          throw new NotFoundException(`Fact ${factId} not found`);
        }
      }

      // Predicate-class authorization: billing_event / human_declared /
      // legal-source facts need brain:admin. brain:write alone OK for
      // the rest. callerScopes is optional (legacy in-process callers
      // skip the check) — but the HTTP path always supplies it.
      if (callerScopes && retractRequiresAdmin(existing)) {
        if (!callerScopes.includes('brain:admin')) {
          throw new ForbiddenException(
            `retract of predicate='${existing.predicate}' (or legal source) requires brain:admin`,
          );
        }
      }
      if (existing.retractedAt) {
        return {
          factId: String(existing.id),
          retractedAt: new Date(existing.retractedAt).toISOString(),
          cascadedFactIds: [],
          revivedFactIds: [],
        };
      }

      const cascaded = await this.cascadeRetract({
        db,
        parentFactId: String(existing.id),
        now,
        reason: dto.reason,
      });

      await dbMerge(db, `knowledge_fact:${ref.id}`, {
        status: 'retracted',
        retractedAt: now,
        retractedBy: dto.retractedBy.source,
        retractionReason: dto.reason,
        validUntil: existing.validUntil ?? now,
      });

      // Revive the supersede chain. Any fact that was marked
      // superseded by this fact and was NOT separately retracted on
      // its own merits is brought back to status='active' with the
      // pre-supersede validUntil snapshot (priorValidUntil — written
      // by fn::resolve_fact in migration 0021). Predecessors that
      // were explicitly retracted (retractedAt set with a non-
      // 'superseded' reason) keep their state — their hidden-ness
      // had an independent cause.
      const revived = await this.reviveSupersededBy(db, String(existing.id));

      this.logger.log(
        `[knowledge.fact.retracted] companyId=${companyId} factId=${existing.id} cascaded=${cascaded.length} revived=${revived.length}`,
      );

      this.metrics?.countRetract();

      return {
        factId: String(existing.id),
        retractedAt: now.toISOString(),
        cascadedFactIds: cascaded,
        revivedFactIds: revived,
      };
    });
  }

  /**
   * Revive every fact whose `supersededBy` equals the just-retracted
   * fact AND whose retractionReason is exactly 'superseded' (the
   * sentinel fn::resolve_fact writes when it marks a competitor
   * superseded — distinct from operator-driven retracts which carry
   * a free-text reason). Restores:
   *   status          'superseded' → 'active'
   *   retractedAt     → NONE
   *   retractedBy     → NONE
   *   retractionReason → NONE
   *   supersededBy    → NONE
   *   validUntil      → priorValidUntil
   *   priorValidUntil → NONE
   *
   * Idempotent — running twice on the same retract is a no-op
   * because the first pass already moved status to 'active' and
   * cleared the supersededBy edge.
   */
  private async reviveSupersededBy(
    db: Surreal,
    retractedFactId: string,
  ): Promise<string[]> {
    const rid = this.normalizeFactId(retractedFactId).id;
    // One set-based UPDATE instead of SELECT + one UPDATE per row.
    // `validUntil = priorValidUntil` reads each row's OWN field; SET
    // assignments apply left-to-right, so clearing priorValidUntil after
    // the copy is safe (same in-order semantics the per-row form relied
    // on). Explicit `= NONE` — MERGE with JSON null does not unset an
    // option<datetime> field. With fact_superseded_by_idx (0059) the
    // WHERE is an index probe, not a table scan.
    const [rows] = await db.query<any[][]>(
      `UPDATE knowledge_fact SET
          status = 'active',
          retractedAt = NONE,
          retractedBy = NONE,
          retractionReason = NONE,
          supersededBy = NONE,
          validUntil = priorValidUntil,
          priorValidUntil = NONE
        WHERE supersededBy = type::record('knowledge_fact', $rid)
          AND status = 'superseded'
          AND retractionReason = 'superseded'
        RETURN id`,
      { rid },
    );
    return (((rows as Array<{ id: unknown }>) ?? [])).map((r) => String(r.id));
  }

  /**
   * Walk derivedFrom edges. Any fact whose derivedFrom contains the retracted
   * fact (and has no other still-active parent) gets cascade-retracted.
   *
   * For 0.1.0 we apply a simpler rule: if any parent is retracted, the child
   * is retracted. Lazy re-validation on retrieval is a 0.2.0 enhancement.
   */
  private async cascadeRetract({
    db,
    parentFactId,
    now,
    reason,
  }: {
    db: Surreal;
    parentFactId: string;
    now: Date;
    reason: string;
  }): Promise<string[]> {
    // Atomic reverse-derivedFrom closure in one call (migration 0069). Replaces
    // the former per-node SELECT + per-child UPDATE loop, which was N+1 and
    // interleavable with a concurrent retract / a child inserted mid-walk. The
    // stored fn recurses level-by-level with a single set-based UPDATE each,
    // applying identical field semantics.
    const rid = this.normalizeFactId(parentFactId).id;
    const [rows] = await db.query<[unknown[]]>(
      `RETURN fn::cascade_retract(
         [type::record('knowledge_fact', $rid)], $reason, $now
       )`,
      { rid, reason, now },
    );
    return ((rows as unknown[]) ?? []).map((r) => String(r));
  }

  /**
   * List facts in status='competing' for one entity. The conflict
   * resolver writes facts here whenever two bitemporal facts share a
   * predicate, overlap in valid-time, and are too cosine-close to
   * supersede one another within margin. Use for agent-side
   * adjudication (operator picks the winner) or for surfacing
   * unresolved disagreements to a human review queue.
   *
   * Groups facts by `(entityId, predicate)` — a competing PAIR
   * (group of 2) is the most common shape; groups of 3+ exist when
   * the resolver hit a multi-way conflict it refused to auto-pick.
   *
   * `asOf` filters to facts that were live at that moment: not
   * recorded after it, not retracted before it. Omit asOf for "what
   * is competing right now".
   */
  async listCompeting(
    companyId: string,
    entityIdRaw: string,
    opts: {
      predicate?: string;
      asOf?: string;
      /** Caller's scopes — binds the DB-level PII fence (migration 0005). */
      callerScopes?: readonly string[];
    } = {},
  ): Promise<ListCompetingResult> {
    // Scoped pool when the caller identifies itself (the MCP path — the
    // only consumer today): competing rows carry raw `object` values, so
    // they must respect the $caller_scopes PII fence like every other read.
    const run = <T>(fn: (db: Surreal) => Promise<T>) =>
      opts.callerScopes
        ? this.surreal.withScopedCompany(companyId, opts.callerScopes, fn)
        : this.surreal.withCompany(companyId, fn);
    return run(async (db) => {
      const ref = this.normalizeEntityId(entityIdRaw);
      const asOf = opts.asOf ? new Date(opts.asOf) : null;

      const clauses = [
        `entityId = type::record('knowledge_entity', $rid)`,
        `status = 'competing'`,
        // User scope (0055): competing adjudication is tenant-global v1.
        `userId IS NONE`,
      ];
      const params: Record<string, unknown> = { rid: ref.id };
      if (opts.predicate) {
        clauses.push(`predicate = $predicate`);
        params.predicate = opts.predicate;
      }
      if (asOf) {
        clauses.push(
          `recordedAt <= $asOf`,
          `(retractedAt IS NONE OR retractedAt > $asOf)`,
        );
        params.asOf = asOf;
      } else {
        clauses.push(`retractedAt IS NONE`);
      }

      const [rows] = await db.query<any[][]>(
        `SELECT id, entityId, predicate, object, confidence,
                validFrom, validUntil, recordedAt, source,
                trustSnapshot, corroboration
           FROM knowledge_fact
           WHERE ${clauses.join(' AND ')}
           ORDER BY predicate ASC, recordedAt ASC`,
        params,
      );

      // Scope + ABAC row gate. Pre-ABAC this path leaned on the DB-level
      // PII fence alone (scoped pool, object-null on address/dob); the
      // JS filter now applies the same requiresScope drop as search plus
      // any per-key source rules.
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.callerScopes ?? [],
        surface: 'competing_facts',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
      });
      const visible = (((rows as any[]) ?? []) as PolicyFilterableRow[]).filter(
        (r) => rowPolicy.filter(r),
      );
      rowPolicy.finish();

      const records: CompetingFactRecord[] = (visible as any[]).map(
        (r): CompetingFactRecord => ({
          factId: String(r.id),
          entityId: String(r.entityId),
          predicate: String(r.predicate),
          object: String(r.object),
          confidence: typeof r.confidence === 'number' ? r.confidence : 0,
          validFrom: toIso(r.validFrom),
          validUntil: r.validUntil ? toIso(r.validUntil) : undefined,
          recordedAt: toIso(r.recordedAt),
          source: r.source,
        }),
      );

      const groupMap = new Map<string, CompetingFactGroup>();
      for (const f of records) {
        const key = `${f.entityId}::${f.predicate}`;
        const existing = groupMap.get(key);
        if (existing) {
          existing.facts.push(f);
        } else {
          groupMap.set(key, {
            key,
            entityId: f.entityId,
            predicate: f.predicate,
            facts: [f],
          });
        }
      }

      return {
        entityId: `knowledge_entity:${ref.id}`,
        asOf: asOf ? asOf.toISOString() : undefined,
        groups: Array.from(groupMap.values()),
      };
    });
  }

  /**
   * Active-believed-now facts for ONE predicate, optionally scoped to an
   * entity — the `facts_by_predicate` surface of pack-declared MCP query
   * tools (docs/mcp-pack-tools.md). The caller (registerPackTools) has
   * already composed the namespaced predicate id from the pack manifest,
   * so this read can never leave the pack's own vocabulary. Mold:
   * EntitiesService.getTimeline — scoped pool, bitemporal closure pushed
   * into WHERE, overfetch ×2 for the row fence, slice after filtering.
   */
  async listByPredicate(opts: {
    companyId: string;
    /** FULL namespaced predicate id (`<packId>__<localId>`). */
    predicate: string;
    /** Optional entity scope — short or `knowledge_entity:` form. */
    entityIdRaw?: string;
    limit: number;
    scopes: readonly BrainScope[];
  }): Promise<{
    predicate: string;
    found: number;
    facts: Array<{
      factId: string;
      entityId: string;
      predicate: string;
      object: string;
      confidence: number;
      validFrom: string;
      validUntil?: string;
      recordedAt: string;
      status: string;
    }>;
  }> {
    const { companyId, predicate, entityIdRaw, limit, scopes } = opts;
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const { clauses: activeClauses, params: activeParams } =
        activeFactWhere(null);
      const clauses = [
        `predicate = $predicate`,
        // User scope (0055): pack tool reads are tenant-global v1.
        `userId IS NONE`,
        ...activeClauses,
      ];
      const params: Record<string, unknown> = { predicate, ...activeParams };
      if (entityIdRaw) {
        const ref = this.normalizeEntityId(entityIdRaw);
        clauses.push(`entityId = type::record('knowledge_entity:' + $rid)`);
        params.rid = ref.id;
      }
      // ×2 headroom so the scope/ABAC row fence doesn't starve the page.
      const overfetch = Math.min(limit * 2, 100);
      const [rows] = await db.query<any[][]>(
        `SELECT id, entityId, predicate, object, confidence,
                validFrom, validUntil, recordedAt, status,
                source, trustSnapshot, corroboration, userId
           FROM knowledge_fact
           WHERE ${clauses.join(' AND ')}
           ORDER BY recordedAt DESC
           LIMIT ${overfetch}`,
        params,
      );
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: scopes,
        surface: 'pack_facts_by_predicate',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
      });
      const visible = (((rows as any[]) ?? []) as PolicyFilterableRow[]).filter(
        (r) => rowPolicy.filter(r),
      );
      rowPolicy.finish();
      const facts = (visible as any[]).slice(0, limit).map((r) => ({
        factId: String(r.id),
        entityId: String(r.entityId),
        predicate: String(r.predicate),
        object: String(r.object),
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        validFrom: toIso(r.validFrom),
        validUntil: r.validUntil ? toIso(r.validUntil) : undefined,
        recordedAt: toIso(r.recordedAt),
        status: String(r.status),
      }));
      return { predicate, found: facts.length, facts };
    });
  }

  /**
   * Accept either `<id>` or `knowledge_fact:<id>` as the URL path parameter.
   */
  private normalizeFactId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_fact:') ? raw.slice('knowledge_fact:'.length) : raw;
    return { id, full: `knowledge_fact:${id}` };
  }

  private normalizeEntityId(raw: string): { id: string; full: string } {
    const id = raw.startsWith('knowledge_entity:')
      ? raw.slice('knowledge_entity:'.length)
      : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return new Date().toISOString();
}
