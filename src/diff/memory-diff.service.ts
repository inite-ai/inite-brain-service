import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { makeRowPolicyFilter } from '../policy/row-filter';

/**
 * memory_diff — return everything brain learned (and unlearned) between
 * two bitemporal cursors. Driving use case: "what changed since our
 * last conversation?" — the agent fetches a diff over the session
 * window and decides what's worth surfacing.
 *
 * Source of truth: knowledge_fact's own bitemporal columns:
 *   - recordedAt   → when brain first wrote the fact (creation cursor)
 *   - retractedAt  → when brain marked it retracted/superseded
 *   - supersededBy → which fact replaced it
 *
 * We do NOT read from audit_event today: the changefeed consumer is
 * disabled in tests + behind an env gate in production, so audit_event
 * is unreliable when this tool is called from MCP. The cost of going
 * straight at knowledge_fact: if a fact's retract has been compacted
 * away (none today — compaction service does not purge retracted rows),
 * the diff would miss it. Acceptable trade-off for the 0.1.0 cut; if
 * compaction ever starts purging, we layer audit_event on top.
 *
 * Window semantics: [from, to). A fact whose recordedAt equals `from`
 * is INSIDE the window. A fact whose recordedAt equals `to` is OUTSIDE
 * — that's the next window's create. This matches the standard
 * half-open interval convention so a chain of diffs over consecutive
 * windows never double-counts.
 */
@Injectable()
export class MemoryDiffService {
  private readonly logger = new Logger(MemoryDiffService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  async diff(
    companyId: string,
    args: MemoryDiffArgs,
    callerScopes: readonly string[],
  ): Promise<MemoryDiffResult> {
    const from = new Date(args.from);
    const to = new Date(args.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('memory_diff: invalid from/to ISO datetime');
    }
    if (from.getTime() >= to.getTime()) {
      throw new Error('memory_diff: from must be strictly before to');
    }

    // The diff SELECTs fact `object` values, so it must run the same
    // app-layer gate as every other read surface: the DB-level PII fence
    // (migration 0005) is inert for the system-user pool (verified in
    // test/abac-db-fence.e2e-spec.ts), so the scoped pool alone leaks —
    // the JS filter (requiresScope PII gate + ABAC row rules) is the only
    // working gate. Rows the caller may not see never enter the result.
    const policyLookup = await this.predicateRegistry?.rowPolicyLookup(
      companyId,
    );
    return this.surreal.withScopedCompany(companyId, callerScopes, async (db) => {
      const scoping = buildScoping(args);
      const rowFilter = makeRowPolicyFilter({
        callerScopes,
        surface: 'memory_diff',
        policyLookup,
      });

      // Per-section row cap. The window is caller-controlled (MCP args)
      // — without a cap, from=1970 dumps the tenant's entire fact table
      // into one JSON response. SECTION_CAP+1 is fetched so `truncated`
      // can be reported without a COUNT round-trip; callers narrow the
      // window (or filter) to see the rest.
      const cap = SECTION_CAP + 1;

      // CREATED: facts whose recordedAt landed in [from, to). We don't
      // care whether they were later retracted — at the moment of
      // creation, the agent learned something.
      const [createdRows] = await db.query<any[][]>(
        `SELECT ${FACT_FIELDS}
           FROM knowledge_fact
           WHERE recordedAt >= $from AND recordedAt < $to
                 ${scoping.factClause}
           ORDER BY recordedAt ASC LIMIT $cap`,
        { from, to, cap, ...scoping.params },
      );

      // RETRACTED / SUPERSEDED: facts whose retractedAt landed in the
      // window. status=='superseded' rides on supersededBy — we'll
      // partition that out as `changedFacts` so the caller sees the
      // replacement, not just the disappearance.
      const [retractedRows] = await db.query<any[][]>(
        `SELECT ${FACT_FIELDS}, supersededBy
           FROM knowledge_fact
           WHERE retractedAt >= $from AND retractedAt < $to
                 ${scoping.factClause}
           ORDER BY retractedAt ASC LIMIT $cap`,
        { from, to, cap, ...scoping.params },
      );

      // NEW ENTITIES — knowledge_entity.createdAt within window.
      const [newEntityRows] = await db.query<any[][]>(
        `SELECT id, type, canonicalName, externalRefs, createdAt
           FROM knowledge_entity
           WHERE createdAt >= $from AND createdAt < $to
                 ${scoping.entityClause}
           ORDER BY createdAt ASC LIMIT $cap`,
        { from, to, cap, ...scoping.params },
      );

      // FORGOTTEN ENTITIES — GDPR-grade erasures by forgottenAt.
      // Note: we cannot scope by entityId here (the original id is
      // hashed in the tombstone), so the entityIds filter is ignored
      // for this section.
      const [forgottenRows] = await db.query<any[][]>(
        `SELECT entityIdHash, reason, requestId, forgottenAt
           FROM forgotten_entity
           WHERE forgottenAt >= $from AND forgottenAt < $to
           ORDER BY forgottenAt ASC LIMIT $cap`,
        { from, to, cap },
      );

      let truncated = false;
      const clip = <T>(rows: T[] | undefined | null): T[] => {
        const list = (rows as T[]) ?? [];
        if (list.length > SECTION_CAP) {
          truncated = true;
          return list.slice(0, SECTION_CAP);
        }
        return list;
      };
      const createdClipped = clip(createdRows as any[]);
      const retractedClipped = clip(retractedRows as any[]);
      const newEntityClipped = clip(newEntityRows as any[]);
      const forgottenClipped = clip(forgottenRows as any[]);

      const createdFacts: FactRef[] = createdClipped
        .filter((r) => rowFilter.filter(r))
        .map(rowToFactRef);
      const retracted: Array<FactRef & { supersededBy?: string }> =
        retractedClipped
        .filter((r) => rowFilter.filter(r))
        .map((r) => ({
          ...rowToFactRef(r),
          supersededBy: r.supersededBy ? String(r.supersededBy) : undefined,
        }));

      // Partition the retract bucket: rows with supersededBy are
      // "changed" — replacement story; rows without supersededBy are
      // pure retracts.
      const changedFacts: ChangedFact[] = [];
      const retractedFacts: FactRef[] = [];
      const supersedeeIds = new Set<string>();
      for (const f of retracted) {
        if (f.supersededBy) {
          supersedeeIds.add(f.factId);
          changedFacts.push({
            factId: f.factId,
            replacedBy: f.supersededBy,
            before: f,
          });
        } else {
          retractedFacts.push({
            factId: f.factId,
            entityId: f.entityId,
            predicate: f.predicate,
            object: f.object,
            confidence: f.confidence,
            validFrom: f.validFrom,
            validUntil: f.validUntil,
            recordedAt: f.recordedAt,
            retractedAt: f.retractedAt,
          });
        }
      }

      // Fetch the `after` snapshot for every changedFacts entry in ONE
      // round trip. The id column is record<knowledge_fact>, so plain
      // strings don't match — bind StringRecordId values and use
      // INSIDE, the same battle-tested idiom as search's where-builder
      // entityIds filter.
      const replacementIds = Array.from(
        new Set(
          changedFacts.map((c) =>
            c.replacedBy.startsWith('knowledge_fact:')
              ? c.replacedBy
              : `knowledge_fact:${c.replacedBy}`,
          ),
        ),
      );
      const replacementMap = new Map<string, FactRef>();
      if (replacementIds.length > 0) {
        const [afterRows] = await db.query<any[][]>(
          `SELECT ${FACT_FIELDS}
             FROM knowledge_fact
             WHERE id INSIDE $ids`,
          { ids: replacementIds.map((id) => new StringRecordId(id)) },
        );
        for (const r of (afterRows as any[]) ?? []) {
          if (rowFilter.filter(r)) {
            const ref = rowToFactRef(r);
            replacementMap.set(ref.factId, ref);
          }
        }
      }
      for (const c of changedFacts) {
        c.after = replacementMap.get(c.replacedBy);
      }

      // Emit only NET-new creates in the CREATED bucket — a row that
      // was created AND then superseded by another in the same window
      // is a "changed" event; counting it as both create and change
      // would let callers double-spend.
      const netCreated = createdFacts.filter((c) => !supersedeeIds.has(c.factId));

      const newEntities: EntityRef[] = newEntityClipped.map(
        (r: any) => ({
          entityId: String(r.id),
          type: r.type ? String(r.type) : 'unknown',
          canonicalName: r.canonicalName ? String(r.canonicalName) : '',
          externalRefs: (r.externalRefs ?? {}) as Record<string, string>,
          createdAt: toIso(r.createdAt),
        }),
      );

      const forgottenEntities: ForgottenRef[] = forgottenClipped.map(
        (r: any) => ({
        entityIdHash: String(r.entityIdHash),
        reason: String(r.reason),
        requestId: r.requestId ? String(r.requestId) : undefined,
        forgottenAt: toIso(r.forgottenAt),
      }));

      rowFilter.finish();

      this.logger.log(
        `[memory.diff] companyId=${companyId} window=${from.toISOString()}..${to.toISOString()} ` +
          `created=${netCreated.length} retracted=${retractedFacts.length} ` +
          `changed=${changedFacts.length} newEntities=${newEntities.length} ` +
          `forgotten=${forgottenEntities.length}`,
      );

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        createdFacts: netCreated,
        retractedFacts,
        changedFacts,
        newEntities,
        forgottenEntities,
        truncated,
      };
    });
  }
}

const FACT_FIELDS =
  'id, entityId, predicate, object, confidence, validFrom, validUntil, ' +
  'recordedAt, retractedAt, userId, source, trustSnapshot, corroboration';

/**
 * Max rows returned per diff section. The window is caller-controlled;
 * this cap is what stands between a from=1970 request and a full-table
 * dump. When any section hits the cap the result carries truncated=true
 * — callers narrow the window to page through.
 */
const SECTION_CAP = 500;

interface ScopingClauses {
  factClause: string;
  entityClause: string;
  params: Record<string, unknown>;
}

function buildScoping(args: MemoryDiffArgs): ScopingClauses {
  const params: Record<string, unknown> = {};
  // User scope (0055): the diff surface is tenant-global v1 —
  // personal rows never appear in another caller's window.
  const factParts: string[] = ['userId IS NONE'];
  const entityParts: string[] = ['userId IS NONE'];

  if (args.entityIds && args.entityIds.length > 0) {
    // Bind actual record ids (StringRecordId) and filter with INSIDE —
    // the same idiom as search's where-builder. The previous
    // `IN (SELECT type::record(id) FROM $entityIds AS id)` form was a
    // PARSE ERROR (`FROM $param AS alias` is not SurrealQL) that only
    // fired when a caller actually passed entityIds.
    params.entityIds = args.entityIds.map(
      (id) =>
        new StringRecordId(
          id.startsWith('knowledge_entity:') ? id : `knowledge_entity:${id}`,
        ),
    );
    factParts.push(`entityId INSIDE $entityIds`);
    entityParts.push(`id INSIDE $entityIds`);
  }

  if (args.predicates && args.predicates.length > 0) {
    params.predicates = args.predicates;
    factParts.push(`predicate IN $predicates`);
  }

  return {
    factClause: factParts.length > 0 ? `AND ${factParts.join(' AND ')}` : '',
    entityClause:
      entityParts.length > 0 ? `AND ${entityParts.join(' AND ')}` : '',
    params,
  };
}

function rowToFactRef(r: any): FactRef {
  return {
    factId: String(r.id),
    entityId: String(r.entityId),
    predicate: String(r.predicate),
    object: String(r.object),
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    validFrom: toIso(r.validFrom),
    validUntil: r.validUntil ? toIso(r.validUntil) : undefined,
    recordedAt: toIso(r.recordedAt),
    retractedAt: r.retractedAt ? toIso(r.retractedAt) : undefined,
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return '';
}

export interface MemoryDiffArgs {
  from: string;
  to: string;
  /** Restrict to a set of entities. Short or full ids both accepted. */
  entityIds?: string[];
  /** Restrict to a set of predicates. */
  predicates?: string[];
}

export interface FactRef {
  factId: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validUntil?: string;
  recordedAt: string;
  retractedAt?: string;
}

export interface ChangedFact {
  factId: string;
  replacedBy: string;
  before: FactRef;
  after?: FactRef;
}

export interface EntityRef {
  entityId: string;
  type: string;
  canonicalName: string;
  externalRefs: Record<string, string>;
  createdAt: string;
}

export interface ForgottenRef {
  entityIdHash: string;
  reason: string;
  requestId?: string;
  forgottenAt: string;
}

export interface MemoryDiffResult {
  from: string;
  to: string;
  createdFacts: FactRef[];
  retractedFacts: FactRef[];
  changedFacts: ChangedFact[];
  newEntities: EntityRef[];
  forgottenEntities: ForgottenRef[];
  /** True when any section hit its row cap — narrow the window to see the rest. */
  truncated: boolean;
}
