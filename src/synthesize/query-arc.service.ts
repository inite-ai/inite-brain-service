import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import {
  ReadPinService,
  derivedVersionFence,
} from '../episodes/read-pin.service';
import {
  filterMentions,
  LEX_MATCH_FLOOR,
  type ScanRow,
} from './mention-scan';
import {
  extractArcTopic,
  pickArcBeats,
  renderArcLines,
  type ArcBeat,
} from './query-arc';
import {
  BRUTE_ONLY,
  runDenseScanLeg,
  type CoverageScanTuning,
} from './scan-leg';
import { buildLexMatchLeg } from './lex-leg';
import type { CoverageLexMode } from '../search/retrieval-profile';
import { makeRowPolicyFilter } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';

/** The query_arc gate stack is ~7 predicates deep (atomic/status/world
 *  on top of pii/user), so its approximate KNN overfetches twice the
 *  shared multiplier — the ×8 precedent of the inline entity-resolution
 *  KNN, chosen for the same KNN-before-a-heavy-WHERE shape. */
const ARC_GATE_OVERFETCH_FACTOR = 2;

interface FactScanRow {
  id: unknown;
  predicate: string;
  object: string;
  validFrom: Date | string;
  score?: number;
  // Policy fields (audit 2026-08-19 P1: the row filter reads source /
  // trustSnapshot / corroboration / userId — a projection without them
  // evaluated source- and trust-conditioned rules over null).
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

/** The one projection every policy-filtered fact read uses. */
const POLICY_PROJECTION =
  'id, predicate, object, validFrom, source, trustSnapshot, corroboration, userId';

/**
 * Query-time arc lane (V10 §4, insightEvidence='query_arc').
 *
 * Assembles the topic arc for THIS question at read time: the topic
 * phrase extracted from the question is matched against the ATOMIC
 * fact record (dense + BM25 against the TOPIC, coverage-first — the
 * mention-scan doctrine over knowledge_fact), the most topical beats
 * are kept, and the record is emitted as one chronological dated
 * section under the insight slot. Stored insight rows (write-time
 * aggregates/arcs) are excluded from the pool — under 'query_arc'
 * they are excluded from the fact legs too, so a world that
 * permanently carries them reads clean.
 *
 * Same contracts as the sibling lanes: PII gate for callers without
 * brain:read_pii, fail-closed user scope, derived-world pin resolved
 * per tenant, degrade to [] on any failure, no env reads.
 */
@Injectable()
export class QueryArcService {
  private readonly logger = new Logger(QueryArcService.name);

  /** Scan breadth per leg — coverage-first, not top-K (sized like the
   *  mention scan: every session's facts of a BEAM world, several
   *  times over). */
  private static readonly SCAN_FETCH_CAP = 200;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    @Optional() private readonly readPin?: ReadPinService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  async arcLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string;
    /** Dense-leg mode (V11 §5 scale gate); omitted → the exact scan. */
    scan?: CoverageScanTuning;
    /** Lexical-leg shape (V11 A2); omitted → the legacy phrase matcher. */
    lex?: CoverageLexMode;
  }): Promise<string[]> {
    const topic = extractArcTopic(opts.query);
    const piiGate = opts.callerScopes.includes('brain:read_pii')
      ? ''
      : 'AND piiClass IS NONE';
    // Fail-closed user scope — same contract as the fact legs (0055).
    const userGate = opts.userId
      ? 'AND (userId IS NONE OR userId = $scopeUserId)'
      : 'AND userId IS NONE';
    const userParams = opts.userId ? { scopeUserId: opts.userId } : {};
    const k = QueryArcService.SCAN_FETCH_CAP;
    try {
      const derivedVersion =
        (await this.readPin?.resolveRead(opts.companyId)) ??
        ReadPinService.bootstrapRead();
      const fence = derivedVersionFence(derivedVersion);
      const worldGate = fence.clause;
      const worldParams = fence.params;
      // The atomic pool: the exact inverse of the insight leg's gate,
      // so stored write-time aggregates/arcs never self-ingest into a
      // query-time arc; lifecycle-closed rows stay out of narratives.
      const atomicGate = `AND !(source.recorder = $insightRecorder
             OR string::starts_with(predicate, 'summary_'))
           AND retractedAt IS NONE
           AND status = 'active'`;
      const shared = {
        insightRecorder: 'aggregate-composer-v1',
        k,
        ...userParams,
        ...worldParams,
      };
      const topicVector = await this.embedder.embed(topic);
      // Predicate scope-fence + ABAC row verdict — the same seam every
      // fact read surface applies (audit 2026-08-13 P0: the SQL gates
      // cover pii/user, but an operator-set requiresScope on a tenant
      // predicate only lives in the registry).
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.callerScopes,
        surface: 'query_arc',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(
          opts.companyId,
        ),
      });
      const baseTuning = opts.scan ?? BRUTE_ONLY;
      const tuning: CoverageScanTuning = {
        ...baseTuning,
        overfetch: baseTuning.overfetch * ARC_GATE_OVERFETCH_FACTOR,
      };
      const pool = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const dense = await runDenseScanLeg<FactScanRow>({
            db,
            table: 'knowledge_fact',
            projection: POLICY_PROJECTION,
            gates: `${atomicGate} ${piiGate} ${userGate} ${worldGate}`,
            params: { q: topicVector, ...shared },
            k,
            tuning,
            logger: this.logger,
          });
          const lexLeg = buildLexMatchLeg({
            fields: ['searchHaystack', 'object'],
            topic,
            mode: opts.lex ?? 'phrase',
          });
          const [bm25] = await db.query<[FactScanRow[]]>(
            `SELECT ${POLICY_PROJECTION},
                    ${lexLeg.score} AS score
               FROM knowledge_fact
              WHERE ${lexLeg.where}
                ${atomicGate} ${piiGate} ${userGate} ${worldGate}
              ORDER BY score DESC
              LIMIT $k`,
            { ...lexLeg.params, ...shared },
          );
          return mergeFactLegs(
            dense.filter((r) => rowPolicy.filter(r)),
            (bm25 ?? []).filter((r) => rowPolicy.filter(r)),
          );
        },
      );
      rowPolicy.finish();
      // The mention-scan relevance floor decides what counts as ON
      // TOPIC; the beat picker cuts to budget and restores chronology.
      const mentioned = new Set(
        filterMentions(pool.map((p) => p.scan)).map((r) => r.id),
      );
      const beats: ArcBeat[] = pool
        .filter((p) => mentioned.has(p.scan.id))
        .map((p) => p.beat);
      return renderArcLines(pickArcBeats(beats));
    } catch (e) {
      this.logger.warn(
        `query-time arc failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}

/** Union the dense and lexical pools by record id, keeping both the
 *  ScanRow view (for the shared relevance floor) and the beat view. */
function mergeFactLegs(
  dense: FactScanRow[],
  bm25: FactScanRow[],
): Array<{ scan: ScanRow; beat: ArcBeat }> {
  const byId = new Map<string, { scan: ScanRow; beat: ArcBeat }>();
  const toEntry = (r: FactScanRow): { scan: ScanRow; beat: ArcBeat } => {
    // The SDK decodes datetime columns to JS Dates (CBOR); String(Date)
    // is "Sat Aug 09 2026 …", which breaks both the [YYYY-MM-DD] day
    // slice and the lexicographic chronology sort in pickArcBeats —
    // normalize to ISO before the beat ever sees it.
    const validFromIso =
      r.validFrom instanceof Date
        ? r.validFrom.toISOString()
        : String(r.validFrom);
    return {
      scan: {
        id: String(r.id),
        text: r.object,
        occurredAt: new Date(r.validFrom as string).getTime(),
      },
      beat: { object: r.object, validFrom: validFromIso },
    };
  };
  for (const r of dense) {
    const e = toEntry(r);
    e.scan.sim = typeof r.score === 'number' ? r.score : undefined;
    e.beat.sim = e.scan.sim;
    byId.set(e.scan.id, e);
  }
  for (const r of bm25) {
    const id = String(r.id);
    const lex =
      typeof r.score === 'number' && r.score > 0 ? r.score : LEX_MATCH_FLOOR;
    const prev = byId.get(id);
    if (prev) {
      prev.scan.lex = lex;
      prev.beat.lex = lex;
    } else {
      const e = toEntry(r);
      e.scan.lex = lex;
      e.beat.lex = lex;
      byId.set(id, e);
    }
  }
  return [...byId.values()];
}
