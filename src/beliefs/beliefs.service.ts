import { Injectable, NotFoundException } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { BrainScope } from '../auth/api-key.types';
import { pinUserScope } from '../auth/user-scope';

/**
 * Belief read surface (Belief-B, BELIEFS_API_ENABLED — default off →
 * 404): read-only serving of the semantic_belief substrate (migration
 * 0120) the Belief-A promotion pass writes. Mirrors the FactsService
 * read idiom (getFact / listByPredicate) — every visibility miss is a
 * 404, never a 403, so existence never leaks.
 *
 * Fences (getBelief; the list pushes the same verdict into WHERE and
 * re-applies it in JS):
 *  - tenant: withScopedCompany pins the per-tenant database — a foreign
 *    tenant's belief id simply is not present here;
 *  - user scope: a belief ALWAYS carries the single-user scope its
 *    promotion stamped (#387 fail-closed fence — never tenant-global).
 *    Via pinUserScope, a user-bound token sees only its OWN beliefs;
 *    an M2M credential sees the whole tenant. A row whose userId stamp
 *    is missing/blank (out-of-contract) is invisible to EVERYONE —
 *    fail-closed, the same doctrine the promotion applies on write.
 *
 * No PII fence: semantic_belief carries no piiClass column (0120) —
 * statements are distilled state, not verbatim turns; the raw text
 * stays behind the episode read port's brain:read_pii gate.
 *
 * No row policy: beliefs are keyed by FREE-TEXT (subject, field), not
 * by registry predicates — the predicate-scope fence has nothing to
 * key on (the 0120 SemanticBelief/Claim separation).
 */

/** Page caps of GET /v1/beliefs (the episodes-list idiom). */
export const BELIEFS_LIST_MAX = 100;
export const BELIEFS_LIST_DEFAULT = 25;

/** Lifecycle filter values GET /v1/beliefs accepts (default 'active'). */
export const BELIEF_STATUS_FILTERS = ['active', 'superseded', 'all'] as const;
export type BeliefStatusFilter = (typeof BELIEF_STATUS_FILTERS)[number];

/** Wire shape of GET /v1/beliefs/:id (and each list member). */
export interface BeliefReadResult {
  beliefId: string;
  userId: string;
  subject: string;
  field: string;
  value: string;
  priorValue?: string;
  statement: string;
  statementSource: 'template' | 'llm';
  confidence: number;
  revision: number;
  status: string;
  supersededBy?: string;
  validFrom: string;
  validUntil?: string;
  sourceSceneIds: string[];
  conversationIds: string[];
  corroborationCount: number;
  conversationCount: number;
  promoterVersion?: string;
}

/** Wire shape of GET /v1/beliefs. */
export interface BeliefsListResult {
  beliefs: BeliefReadResult[];
  found: number;
}

/** Row shape the read queries select (values validated in JS). */
export interface BeliefReadRow {
  id: unknown;
  userId?: unknown;
  subject?: unknown;
  field?: unknown;
  value?: unknown;
  priorValue?: unknown;
  statement?: unknown;
  statementSource?: unknown;
  confidence?: unknown;
  revision?: unknown;
  status?: unknown;
  supersededBy?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  sourceSceneIds?: unknown;
  conversationIds?: unknown;
  corroborationCount?: unknown;
  conversationCount?: unknown;
  promoterVersion?: unknown;
}

/**
 * The user-scope fence of the belief read path as a pure verdict
 * (the factVisible idiom). scopeUserId is pinUserScope(undefined):
 * undefined = M2M/tenant-wide, else the token's one user. Fail-closed:
 * a row without a well-formed single-user stamp — which the promotion
 * never writes (#387) — is visible to NO caller, M2M included.
 */
export function beliefVisible(
  belief: Pick<BeliefReadRow, 'userId'>,
  scopeUserId: string | undefined,
): boolean {
  const owner =
    typeof belief.userId === 'string' && belief.userId.length > 0 ? belief.userId : null;
  if (owner === null) return false;
  return scopeUserId === undefined || owner === scopeUserId;
}

const SELECT_COLUMNS = `id, userId, subject, field, value, priorValue,
              statement, statementSource, confidence, revision, status,
              supersededBy, validFrom, validUntil, sourceSceneIds,
              conversationIds, corroborationCount, conversationCount,
              promoterVersion`;

interface BeliefReadOptions {
  companyId: string;
  beliefId: string;
  scopes: readonly BrainScope[];
}

export interface BeliefListOptions {
  companyId: string;
  scopes: readonly BrainScope[];
  /** Free-text subject key filter (exact match). */
  subject?: string | undefined;
  /** Free-text field key filter (exact match). */
  field?: string | undefined;
  /**
   * Caller-asserted user scope — pinned via pinUserScope: an M2M key
   * may scope to any user (or omit for tenant-wide), a user-bound
   * token is pinned to its own user (mismatch = 403, the platform-wide
   * pin idiom).
   */
  userId?: string | undefined;
  /** Lifecycle filter, already validated ('active' default). */
  status: BeliefStatusFilter;
  /** Page size, already clamped to 1..BELIEFS_LIST_MAX. */
  limit: number;
}

@Injectable()
export class BeliefsService {
  constructor(private readonly surreal: SurrealService) {}

  /**
   * GET /v1/beliefs/:id — one belief revision as stored. Superseded
   * revisions still resolve (status/supersededBy/validUntil tell the
   * story) — only visibility fences turn into 404s, and any miss is
   * the same 404 ("absent" and "fenced" are indistinguishable).
   */
  async getBelief(opts: BeliefReadOptions): Promise<BeliefReadResult> {
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      const tail = this.normalizeBeliefId(opts.beliefId);
      const rows = await queryRows<BeliefReadRow>(
        db,
        `SELECT ${SELECT_COLUMNS}
           FROM type::record('semantic_belief', $rid) LIMIT 1`,
        { rid: tail },
      );
      const belief = rows[0];
      if (!belief || !beliefVisible(belief, pinUserScope(undefined))) {
        throw new NotFoundException(`Belief ${opts.beliefId} not found`);
      }
      return toWire(belief);
    });
  }

  /**
   * GET /v1/beliefs — list by the free-text (subject, field) key.
   * The user fence is pushed into WHERE (index-backed belief_user_idx;
   * WHERE on secondary-indexed fields is safe for SELECT — only DELETE
   * hits the 3.2.4 planner no-op) so LIMIT never starves the page, and
   * re-applied in JS fail-closed (out-of-contract rows never serve).
   */
  async listBeliefs(opts: BeliefListOptions): Promise<BeliefsListResult> {
    const scopeUserId = pinUserScope(opts.userId);
    return this.surreal.withScopedCompany(opts.companyId, opts.scopes, async (db) => {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (scopeUserId !== undefined) {
        clauses.push('userId = $u');
        params.u = scopeUserId;
      } else {
        // The fail-closed leg of beliefVisible, pushed into WHERE: an
        // out-of-contract blank stamp must not occupy page slots either
        // (the F1 lesson — a fence applied after LIMIT starves the
        // page). userId is TYPE string (0120), so blank is the only
        // DB-representable out-of-contract shape.
        clauses.push(`userId != ''`);
      }
      if (opts.subject !== undefined) {
        clauses.push('subject = $s');
        params.s = opts.subject;
      }
      if (opts.field !== undefined) {
        clauses.push('field = $f');
        params.f = opts.field;
      }
      if (opts.status !== 'all') {
        clauses.push('status = $st');
        params.st = opts.status;
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = await queryRows<BeliefReadRow>(
        db,
        `SELECT ${SELECT_COLUMNS}
           FROM semantic_belief${where}
          ORDER BY userId ASC, subject ASC, field ASC, revision DESC
          LIMIT ${opts.limit}`,
        params,
      );
      const beliefs = rows.filter((r) => beliefVisible(r, scopeUserId)).map(toWire);
      return { beliefs, found: beliefs.length };
    });
  }

  /** Accept either `<id>` or `semantic_belief:<id>` as the path param. */
  private normalizeBeliefId(raw: string): string {
    return raw.startsWith('semantic_belief:') ? raw.slice('semantic_belief:'.length) : raw;
  }
}

/** Wire mapping — record ids stringified, datetimes normalized to ISO. */
function toWire(row: BeliefReadRow): BeliefReadResult {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    beliefId: String(row.id),
    userId: String(row.userId ?? ''),
    subject: String(row.subject ?? ''),
    field: String(row.field ?? ''),
    value: String(row.value ?? ''),
    ...(str(row.priorValue) !== undefined ? { priorValue: str(row.priorValue)! } : {}),
    statement: String(row.statement ?? ''),
    // Closed enum by schema assert (0120); anything off-contract reports
    // the deterministic fold, never a fabricated 'llm' attribution.
    statementSource: row.statementSource === 'llm' ? 'llm' : 'template',
    confidence: num(row.confidence),
    revision: num(row.revision),
    status: String(row.status ?? 'active'),
    ...(row.supersededBy !== undefined && row.supersededBy !== null
      ? { supersededBy: String(row.supersededBy) }
      : {}),
    validFrom: toIso(row.validFrom),
    ...(row.validUntil !== undefined && row.validUntil !== null
      ? { validUntil: toIso(row.validUntil) }
      : {}),
    sourceSceneIds: strings(row.sourceSceneIds),
    conversationIds: strings(row.conversationIds),
    corroborationCount: num(row.corroborationCount),
    conversationCount: num(row.conversationCount),
    ...(str(row.promoterVersion) !== undefined
      ? { promoterVersion: str(row.promoterVersion)! }
      : {}),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  // SurrealDB SDK datetime columns decode to the SDK's own DateTime
  // class — duck-type on toISOString (the FactsService toIso lesson:
  // falling through to "now" silently serves request time).
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toISOString?: unknown }).toISOString === 'function'
  ) {
    return (value as { toISOString: () => string }).toISOString();
  }
  return new Date(0).toISOString();
}
