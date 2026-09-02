import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import { SurrealService, dbMerge, queryFirst, queryRows } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { EpisodeReadStoreService, EpisodeQuoteRow } from '../episodes/episode-read-store.service';
import { RetractFactDto } from './dto/retract.dto';
import { BrainScope } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';
import {
  principalScopeTags,
  scopeTagsEnabled,
  visibleUnderScope,
  type PrincipalScope,
} from '../auth/scope-visibility';
import {
  makeRowPolicyFilter,
  type PolicyFilterableRow,
  type RowPolicyFilter,
} from '../policy/row-filter';
import { activeFactWhere } from '../entities/entity-read.helpers';
import {
  closureMaxDepth,
  closureMaxEpisodes,
  closureMaxFacts,
  recursiveClosureEnabled,
  supportGraphReadEnabled,
} from '../common/provenance-flags';
import { readSurfaceUserScopeEnabled } from '../common/read-scope-flags';
import {
  collectSceneTargets,
  indexCharSpans,
  normalizeReconstructedEdges,
  walkProvenanceClosure,
  type ClosureEdgeRow,
  type ProvenanceClosureEdge,
  type ProvenanceSpan,
  type ReconstructedSupportEdge,
} from './provenance-closure';

/**
 * Predicate-class allowlist that requires `brain:admin` for retract,
 * not just `brain:write`. Retracting a fact in any of these classes
 * cascades — `billing_event` rows reach downstream invoicing audits,
 * `human_declared` rows represent operator-attested ground truth, and
 * anything emitted by `source.kind === 'legal'` is regulator-visible.
 * A leaked write-only key shouldn't be able to delete-by-cascade
 * across those surfaces.
 */
export const RETRACT_ADMIN_PREDICATES = new Set<string>(['billing_event', 'human_declared']);

function retractRequiresAdmin(fact: { predicate?: unknown; source?: unknown }): boolean {
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
  validUntil?: string | undefined;
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
  /**
   * Claim grounding state (Drift-1, migration 0115): 'grounded' = the
   * source names an observation; 'ungrounded' = explicitly marked
   * observation-free. Absent = legacy row (predates the
   * EVIDENCE_GROUNDING_STAMP writer — never backfilled).
   */
  groundingStatus?: 'grounded' | 'ungrounded';
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

/**
 * One supporting fact of the recursive closure
 * (PROVENANCE_RECURSIVE_CLOSURE): what the root was derived from,
 * transitively, with its derivedFrom distance and lifecycle status
 * (compacted/retracted members still witness — status is reported,
 * never hidden).
 */
export interface FactProvenanceDerivedFact {
  factId: string;
  predicate: string;
  depth: number;
  status: string;
}

/** Closure walk summary (PROVENANCE_RECURSIVE_CLOSURE). */
export interface FactProvenanceClosure {
  /** Deepest derivedFrom hop reached (root = 0). */
  depth: number;
  /** Supporting facts in the closure (root excluded). */
  factCount: number;
  /** True when a depth / fan-out / episode cap cut the walk short. */
  truncated: boolean;
  /** True when ≥1 member was silently dropped by a visibility fence. */
  filtered: boolean;
}

/** Wire shape of GET /v1/facts/:id/provenance. */
export interface FactProvenanceResult {
  factId: string;
  /** Grounding turns (source.episodeIds), chronological. */
  episodes: FactProvenanceEpisode[];
  /**
   * Recursive support closure (PROVENANCE_RECURSIVE_CLOSURE) — absent
   * (not empty) when the flag is off or the root has no derivedFrom, so
   * the default response stays byte-identical.
   */
  derivedFacts?: FactProvenanceDerivedFact[];
  closure?: FactProvenanceClosure;
  /**
   * Typed support edges crossed by the walk
   * (PROVENANCE_SUPPORT_GRAPH_READ, 0116) — absent (not empty) when the
   * read flag is off, so the default response stays byte-identical.
   * Includes the post-walk scene-evidence zoom edges (reconstructed_from,
   * 0123) for every scene a crossed supported_by edge named.
   */
  supportEdges?: Array<ProvenanceClosureEdge | ReconstructedSupportEdge>;
}

interface FactReadOptions {
  companyId: string;
  factId: string;
  scopes: readonly BrainScope[];
}

/** Row shape loadVisibleFact selects (superset of PolicyFilterableRow). */
export interface FactReadRow extends PolicyFilterableRow {
  id: unknown;
  object?: unknown;
  confidence?: unknown;
  validFrom?: unknown;
  retractedAt?: unknown;
  status?: unknown;
  derivedVersion?: unknown;
  /** Claim grounding state (0115); absent = legacy (pre-stamp). */
  groundingStatus?: unknown;
  /** Scope-tag AND-set (migration 0093); absent/empty = tenant-global. */
  scope?: unknown;
  /** Provenance edges — the closure walk's frontier (option<array>). */
  derivedFrom?: unknown;
}

/**
 * The per-row read fences of loadVisibleFact, resolved once per request
 * so the closure walk can apply the SAME verdict to every member row
 * without rebuilding the policy filter per depth.
 */
export interface FactVisibilityGates {
  /** pinUserScope(undefined) — undefined = M2M/tenant-wide. */
  scopeUserId: string | undefined;
  /** principalScopeTags() when SCOPE_TAGS_ENABLED; null ⇒ fence inert. */
  principalTags: PrincipalScope | null;
  /** Registry-backed scope fence + ABAC verdict (surface 'fact_read'). */
  rowPolicy: Pick<RowPolicyFilter, 'filter'>;
}

/**
 * The fence chain of the fact read path as a pure verdict — user scope
 * (0055), scope tags (G6), then the registry-backed row policy, in the
 * exact order loadVisibleFact has always applied them. No throwing: the
 * root caller turns `false` into its 404, the closure walk turns it into
 * a silent member drop.
 */
export function factVisible(fact: FactReadRow, gates: FactVisibilityGates): boolean {
  // User scope (0055): another user's fact is invisible.
  if (
    gates.scopeUserId !== undefined &&
    typeof fact.userId === 'string' &&
    fact.userId.length > 0 &&
    fact.userId !== gates.scopeUserId
  ) {
    return false;
  }
  // G6 scope-tag fence (SCOPE_TAGS_ENABLED) — ADDED alongside the
  // userId ownership check above, never replacing it. Composed as an
  // extra AND, it can only narrow visibility. Inert when the flag is
  // off (principalTags null). See scope-visibility.ts.
  if (gates.principalTags !== null) {
    const recordScope = Array.isArray(fact.scope)
      ? (fact.scope as unknown[]).map((t) => String(t))
      : [];
    if (!visibleUnderScope(recordScope, gates.principalTags)) return false;
  }
  // Registry-backed row policy (scope fence + ABAC) — same seam as the
  // audit-fixed fact lanes under src/synthesize/.
  return gates.rowPolicy.filter(fact);
}

export interface ListCompetingResult {
  entityId: string;
  asOf?: string | undefined;
  /**
   * Groups, one per (entityId, predicate). Within a group, every fact
   * was placed at status='competing' by the conflict resolver and is
   * still unretracted at `asOf` (or now if asOf is omitted).
   */
  groups: CompetingFactGroup[];
}

/**
 * Columns retract() selects to run its authorization + revive logic.
 * Superset of PolicyFilterableRow so the registry row-policy gate can
 * filter it; datetime fields feed `new Date(...)`, hence string | Date.
 */
interface RetractExistingRow extends PolicyFilterableRow {
  status?: unknown;
  retractedAt?: string | Date;
  validFrom?: string | Date;
  validUntil?: string | Date;
}

/**
 * Columns the competing / by-predicate fact reads select. Superset of
 * PolicyFilterableRow so the row-policy filter and the response mapper
 * share one row type; every value the mapper consumes funnels through
 * String()/toIso()/typeof, so `unknown` is precise enough.
 */
interface CompetingReadRow extends PolicyFilterableRow {
  entityId?: unknown;
  object?: unknown;
  confidence?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  recordedAt?: unknown;
  status?: unknown;
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
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
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
        // Claim grounding state (0115): emitted only for the two stamped
        // values — legacy rows (absent) and any off-contract value emit
        // NO key, so the pre-0115 wire shape is byte-identical.
        ...(fact.groundingStatus === 'grounded' || fact.groundingStatus === 'ungrounded'
          ? { groundingStatus: fact.groundingStatus }
          : {}),
      };
    });
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
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      const fact = await this.loadVisibleFact(db, opts);
      // Recursive closure (PROVENANCE_RECURSIVE_CLOSURE) only for a root
      // that HAS derivedFrom — flag off, or a leaf fact, takes the
      // one-hop path below byte-identically (no optional fields).
      // PROVENANCE_SUPPORT_GRAPH_READ widens the entry: a root with
      // typed edges but an EMPTY derivedFrom array walks too (the edge
      // fetch is what discovers its children).
      const hasDerivedFrom = Array.isArray(fact.derivedFrom) && fact.derivedFrom.length > 0;
      if (recursiveClosureEnabled() && (hasDerivedFrom || supportGraphReadEnabled())) {
        return this.provenanceWithClosure(db, opts, fact);
      }
      const source = (fact.source ?? {}) as {
        episodeIds?: unknown;
        charSpans?: unknown;
      };
      const spanByEpisode = indexCharSpans(source.charSpans);
      const ids = Array.isArray(source.episodeIds)
        ? [...new Set(source.episodeIds.map(String).filter((e) => e.startsWith('episode:')))]
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
      const episodes = this.mapProvenanceEpisodes(rows, spanByEpisode);
      return { factId: String(fact.id), episodes };
    });
  }

  /**
   * PROVENANCE_RECURSIVE_CLOSURE read path: bounded BFS over the root's
   * derivedFrom graph inside the ONE existing scoped connection. The
   * fence gates are resolved ONCE (scope pin, scope tags, one row-policy
   * filter for the whole walk — surface 'fact_read', finish() after) and
   * applied to every member via the same `factVisible` verdict as the
   * root; an invisible member is a silent drop (`filtered`), never an
   * error. Episode fetches group per owning user — a member fact's own
   * userId keys its turns (generalizing the root rule: '' falls back to
   * the caller's pinned scope) — each group one PII-fenced byIds read.
   */
  private async provenanceWithClosure(
    db: Surreal,
    opts: FactReadOptions,
    root: FactReadRow,
  ): Promise<FactProvenanceResult> {
    const scopeUserId = pinUserScope(undefined);
    const principalTags = scopeTagsEnabled() ? principalScopeTags() : null;
    const rowPolicy = makeRowPolicyFilter({
      callerScopes: opts.scopes,
      surface: 'fact_read',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(opts.companyId),
    });
    const gates: FactVisibilityGates = { scopeUserId, principalTags, rowPolicy };
    // Typed support graph read (PROVENANCE_SUPPORT_GRAPH_READ): supply
    // the per-depth edge fetch — ONE batched SELECT over the frontier.
    // Plain WHERE on `in` (the compound support_edge_uq leading field)
    // is safe for a SELECT; only DELETE hits the 3.2.4 planner no-op.
    // Flag off ⇒ no fetchEdges ⇒ the walk is byte-identical.
    const readEdges = supportGraphReadEnabled();
    const caps = {
      maxDepth: closureMaxDepth(),
      maxFacts: closureMaxFacts(),
      maxEpisodes: closureMaxEpisodes(),
    };
    const closure = await walkProvenanceClosure<FactReadRow>({
      root,
      caps,
      visible: (f) => factVisible(f, gates),
      fetchByIds: async (ids) => {
        // NO status filter — compacted/retracted members still witness;
        // status is REPORTED on the wire, not hidden.
        const [rows] = await db.query<[FactReadRow[]]>(
          `SELECT id, predicate, object, confidence, validFrom, validUntil,
                  recordedAt, retractedAt, status, source, userId, scope,
                  derivedVersion, trustSnapshot, corroboration, derivedFrom
             FROM knowledge_fact WHERE id INSIDE $ids`,
          { ids: ids.map((id) => new StringRecordId(id)) },
        );
        return rows ?? [];
      },
      ...(readEdges
        ? {
            fetchEdges: async (ids: string[]) => {
              const [rows] = await db.query<[ClosureEdgeRow[]]>(
                `SELECT id, in, out, kind FROM memory_support WHERE in INSIDE $ids`,
                { ids: ids.map((id) => new StringRecordId(id)) },
              );
              return rows ?? [];
            },
          }
        : {}),
    });
    rowPolicy.finish();

    // Scene-evidence zoom (reconstructed_from, 0123 — MM-zoom PR1): ONE
    // post-walk batched fetch over the scenes the crossed supported_by
    // edges named. Keyed on the SAME read flag as the walk's edge fetch;
    // edges are record-id-only rows (content-free by construction — the
    // 0116 doctrine), the same exposure class as the crossed supported_by
    // targets. Plain WHERE on `in` is SELECT-safe (only DELETE hits the
    // 3.2.4 planner no-op). Flag off ⇒ no fetch, and with no scenes
    // crossed (or no zoom edges written) the appended set is empty — the
    // supportEdges array is byte-identical to the pre-0123 shape.
    let reconstructed: ReconstructedSupportEdge[] = [];
    if (readEdges) {
      const sceneIds = collectSceneTargets(closure.edges);
      if (sceneIds.length > 0) {
        const [edgeRows] = await db.query<[ClosureEdgeRow[]]>(
          `SELECT in, out, kind FROM memory_support
            WHERE kind = 'reconstructed_from' AND in INSIDE $ids`,
          { ids: sceneIds.map((id) => new StringRecordId(id)) },
        );
        reconstructed = normalizeReconstructedEdges(edgeRows ?? [], caps.maxFacts);
      }
    }

    // Episode fetch grouped per owning user ('' → the caller's pinned
    // scope; else that fact's user — the caller already passed the
    // fact-level gate for that member).
    const includePii = opts.scopes.includes('brain:read_pii');
    const byOwner = new Map<string, string[]>();
    for (const [episodeId, owner] of closure.episodes) {
      const group = byOwner.get(owner);
      if (group) group.push(episodeId);
      else byOwner.set(owner, [episodeId]);
    }
    const rows: EpisodeQuoteRow[] = [];
    for (const [owner, ids] of byOwner) {
      rows.push(
        ...(await this.episodes.byIds({
          companyId: opts.companyId,
          ids,
          includePii,
          userId: owner === '' ? scopeUserId : owner,
          db,
        })),
      );
    }
    const episodes = this.mapProvenanceEpisodes(rows, closure.spans);

    const truncated =
      closure.truncated.depth || closure.truncated.fanout || closure.truncated.episodes;
    this.metrics?.countProvenanceClosure(
      truncated ? 'truncated' : closure.closureFacts.length === 0 ? 'empty' : 'resolved',
    );
    return {
      factId: String(root.id),
      episodes,
      derivedFacts: closure.closureFacts.map(({ fact, depth }) => ({
        factId: String(fact.id),
        predicate: String(fact.predicate),
        depth,
        status: String(fact.status ?? 'active'),
      })),
      closure: {
        depth: closure.closureFacts.reduce((acc, c) => Math.max(acc, c.depth), 0),
        factCount: closure.closureFacts.length,
        truncated,
        filtered: closure.filtered,
      },
      // Additive and flag-keyed: PRESENT (possibly empty) whenever the
      // read flag drove the walk, ABSENT otherwise — never an empty
      // array on the default path. Crossed edges first (walk order),
      // then the post-walk scene-evidence zoom edges.
      ...(readEdges ? { supportEdges: [...closure.edges, ...reconstructed] } : {}),
    };
  }

  /**
   * Chronological sort + wire mapping of provenance episode rows —
   * shared by the one-hop path and the closure path so the per-episode
   * shape (PROVENANCE_TEXT_CHAR_CAP, G3 span attachment) has ONE
   * implementation.
   */
  private mapProvenanceEpisodes(
    rows: EpisodeQuoteRow[],
    spanByEpisode: Map<string, ProvenanceSpan>,
  ): FactProvenanceEpisode[] {
    return rows
      .slice()
      .sort(
        (a, b) => new Date(toIso(a.occurredAt)).getTime() - new Date(toIso(b.occurredAt)).getTime(),
      )
      .map((r): FactProvenanceEpisode => {
        // G3: attach the fact's stored char span for this turn.
        // textTruncated rides along because span offsets reference
        // the FULL stored episode text, not the capped `text` view.
        // Span-less episodes keep the pre-G3 shape byte-identical.
        const span = spanByEpisode.get(String(r.id));
        return {
          episodeId: String(r.id),
          ...(r.conversationId !== undefined ? { conversationId: r.conversationId } : {}),
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
  }

  /**
   * Fetch one fact row and apply every read fence (user scope + row
   * policy). Shared by getFact and getProvenance so the two endpoints
   * can never disagree on what "visible" means. Throws NotFound on any
   * miss — the caller cannot distinguish "absent" from "fenced".
   */
  private async loadVisibleFact(db: Surreal, opts: FactReadOptions): Promise<FactReadRow> {
    const ref = this.normalizeFactId(opts.factId);
    const [rows] = await db.query<[FactReadRow[]]>(
      `SELECT id, predicate, object, confidence, validFrom, validUntil,
              recordedAt, retractedAt, status, source, userId, scope,
              derivedVersion, trustSnapshot, corroboration, derivedFrom,
              groundingStatus
         FROM type::record('knowledge_fact', $rid) LIMIT 1`,
      { rid: ref.id },
    );
    const notFound = () => new NotFoundException(`Fact ${opts.factId} not found`);
    const fact = rows?.[0];
    if (!fact) throw notFound();
    // The fence chain lives in factVisible (shared with the closure
    // walk); ANY miss is the same 404 — user scope (0055) and scope tags
    // (G6) 404 rather than 403 so existence never leaks, and a row-
    // policy-fenced predicate is simply absent to callers without the
    // scope.
    const rowPolicy = makeRowPolicyFilter({
      callerScopes: opts.scopes,
      surface: 'fact_read',
      policyLookup: await this.predicateRegistry?.rowPolicyLookup(opts.companyId),
    });
    const visible = factVisible(fact, {
      scopeUserId: pinUserScope(undefined),
      principalTags: scopeTagsEnabled() ? principalScopeTags() : null,
      rowPolicy,
    });
    rowPolicy.finish();
    if (!visible) throw notFound();
    return fact;
  }

  async retract({ companyId, factId, dto, callerScopes }: RetractOptions): Promise<RetractResult> {
    return this.surreal.withCompany(companyId, async (db) => {
      const ref = this.normalizeFactId(factId);
      const now = new Date();

      // Verify the fact exists and is currently active. SELECT extra
      // predicate + source so the admin-scope gate below can read them,
      // and userId for the ownership fence.
      const existing = await queryFirst<RetractExistingRow>(
        db,
        `SELECT id, status, retractedAt, validFrom, predicate, source,
                userId
           FROM type::record('knowledge_fact', $rid) LIMIT 1`,
        { rid: ref.id },
      );
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
          policyLookup: await this.predicateRegistry?.rowPolicyLookup(companyId),
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
  private async reviveSupersededBy(db: Surreal, retractedFactId: string): Promise<string[]> {
    const rid = this.normalizeFactId(retractedFactId).id;
    // One set-based UPDATE instead of SELECT + one UPDATE per row.
    // `validUntil = priorValidUntil` reads each row's OWN field; SET
    // assignments apply left-to-right, so clearing priorValidUntil after
    // the copy is safe (same in-order semantics the per-row form relied
    // on). Explicit `= NONE` — MERGE with JSON null does not unset an
    // option<datetime> field. With fact_superseded_by_idx (0059) the
    // WHERE is an index probe, not a table scan.
    const rows = await queryRows<{ id: unknown }>(
      db,
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
    return rows.map((r) => String(r.id));
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
      /** Per-user memory scope (0055), READ_SURFACE_USER_SCOPE gated.
       *  Caller-asserted; pinned to a user-bound token's end-user via
       *  pinUserScope. Flag on + userId → groups over tenant-global
       *  rows PLUS this user's personal ones; otherwise the historical
       *  tenant-global-only fence, byte-identical. */
      userId?: string;
      /** Caller's scopes — drive the app-layer PII/row filter (the DB-level
       *  PII fence of migration 0005 is inert for the system brain_caller
       *  user; see SurrealService.withScopedCompany). */
      callerScopes?: readonly string[];
    } = {},
  ): Promise<ListCompetingResult> {
    // Scoped pool when the caller identifies itself (the MCP path — the
    // only consumer today): competing rows carry raw `object` values, so
    // they must respect the PII gate like every other read — enforced by
    // the app-layer row filter below (the DB-level $caller_scopes fence is
    // inert for the system brain_caller user).
    const run = <T>(fn: (db: Surreal) => Promise<T>) =>
      opts.callerScopes
        ? this.surreal.withScopedCompany(companyId, opts.callerScopes, fn)
        : this.surreal.withCompany(companyId, fn);
    // READ_SURFACE_USER_SCOPE (default off): this surface predates the
    // 0055 per-user scope and pinned `userId IS NONE`, so a user-scoped
    // COMPETING pair was invisible to adjudication. Flag on → the
    // caller-asserted userId is pinned to a user-bound token's end-user
    // (the ingestFact idiom — 403 on mismatch, defaulted when omitted)
    // and the fence widens to the search-lane union below. Off — or on
    // with no userId in play — keeps the exact historical clause.
    const scopeUserId = readSurfaceUserScopeEnabled() ? pinUserScope(opts.userId) : undefined;
    return run(async (db) => {
      const ref = this.normalizeEntityId(entityIdRaw);
      const asOf = opts.asOf ? new Date(opts.asOf) : null;

      const clauses = [`entityId = type::record('knowledge_entity', $rid)`, `status = 'competing'`];
      const params: Record<string, unknown> = { rid: ref.id };
      if (scopeUserId !== undefined) {
        clauses.push(`(userId IS NONE OR userId = $scopeUserId)`);
        params.scopeUserId = scopeUserId;
      } else {
        // User scope (0055): competing adjudication is tenant-global v1.
        clauses.push(`userId IS NONE`);
      }
      if (opts.predicate) {
        clauses.push(`predicate = $predicate`);
        params.predicate = opts.predicate;
      }
      if (asOf) {
        clauses.push(`recordedAt <= $asOf`, `(retractedAt IS NONE OR retractedAt > $asOf)`);
        params.asOf = asOf;
      } else {
        clauses.push(`retractedAt IS NONE`);
      }

      const rows = await queryRows<CompetingReadRow>(
        db,
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
      const visible = rows.filter((r) => rowPolicy.filter(r));
      rowPolicy.finish();

      const records: CompetingFactRecord[] = visible.map((r): CompetingFactRecord => ({
        factId: String(r.id),
        entityId: String(r.entityId),
        predicate: String(r.predicate),
        object: String(r.object),
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        validFrom: toIso(r.validFrom),
        validUntil: r.validUntil ? toIso(r.validUntil) : undefined,
        recordedAt: toIso(r.recordedAt),
        source: r.source,
      }));

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
      validUntil?: string | undefined;
      recordedAt: string;
      status: string;
    }>;
  }> {
    const { companyId, predicate, entityIdRaw, limit, scopes } = opts;
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const { clauses: activeClauses, params: activeParams } = activeFactWhere(null);
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
      const rows = await queryRows<CompetingReadRow>(
        db,
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
      const visible = rows.filter((r) => rowPolicy.filter(r));
      rowPolicy.finish();
      const facts = visible.slice(0, limit).map((r) => ({
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
    const id = raw.startsWith('knowledge_entity:') ? raw.slice('knowledge_entity:'.length) : raw;
    return { id, full: `knowledge_entity:${id}` };
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  // SurrealDB SDK 2.x decodes datetime columns to its own DateTime class
  // (NOT a native Date — String()/JSON already yield the ISO form).
  // Duck-type on toISOString so live rows don't fall through to the
  // "now" fallback below, which silently served the REQUEST time as
  // occurredAt/validFrom and broke chronological provenance ordering
  // (caught by the closure e2e against a real SurrealDB).
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toISOString?: unknown }).toISOString === 'function'
  ) {
    return (value as { toISOString: () => string }).toISOString();
  }
  return new Date().toISOString();
}
