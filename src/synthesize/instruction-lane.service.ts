import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { makeRowPolicyFilter } from '../policy/row-filter';

/** The predicate the extractor files a standing instruction under. */
export const INSTRUCTION_PREDICATE = 'instruction';
/** Standing instructions per prompt — the section's own budget. */
const INSTRUCTION_TOP_K = 8;

interface InstructionRow {
  id: unknown;
  predicate: string;
  object: string;
  validFrom?: unknown;
  source?: Record<string, unknown> | null;
  trustSnapshot?: { authority?: number; declaredTrust?: number; learnedTrust?: number } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

/**
 * The T7 instruction lane's read: the standing instructions the memory
 * holds for this caller, by predicate.
 *
 * WHY A DIRECT READ. A standing instruction is not something to search
 * for — it is a fact the extractor files under one predicate at write
 * time, from any language, because the sentence said so ("запомни: …",
 * "always …", "write reports for X in Portuguese"). The lane used to
 * run a FULL second search for them, with a fixed bag of trigger words
 * in eight languages as the query and a trigger regex over the results
 * — two rerank stages and three reranker calls per answer, competing
 * with the main search for the cross-encoder worker, to approximate
 * what the predicate states outright. This read is one indexed query
 * with the same fences every prompt-producing lane applies (PII scope,
 * fail-closed user scope, the ABAC row verdict).
 */
@Injectable()
export class InstructionLaneService {
  private readonly logger = new Logger(InstructionLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  /** Instruction texts, newest first; [] on any failure. */
  async instructionLines(opts: {
    companyId: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
  }): Promise<string[]> {
    try {
      const piiGate = opts.callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
      const userGate = opts.userId
        ? 'AND (userId IS NONE OR userId = $scopeUserId)'
        : 'AND userId IS NONE';
      const rows = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [res] = await db.query<[InstructionRow[]]>(
          `SELECT id, predicate, object, validFrom, source, trustSnapshot, corroboration, userId
             FROM knowledge_fact
            WHERE (predicate = $predicate OR predicateAlias = $predicate)
              AND status = 'active' AND retractedAt IS NONE
              ${piiGate} ${userGate}
            ORDER BY validFrom DESC
            LIMIT $k`,
          {
            predicate: INSTRUCTION_PREDICATE,
            k: INSTRUCTION_TOP_K * 2,
            ...(opts.userId ? { scopeUserId: opts.userId } : {}),
          },
        );
        return res ?? [];
      });
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.callerScopes,
        surface: 'instruction_lane',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(opts.companyId),
      });
      const admitted = rows.filter((r) => rowPolicy.filter(r));
      rowPolicy.finish();
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of admitted) {
        const text = r.object.trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= INSTRUCTION_TOP_K) break;
      }
      return out;
    } catch (e) {
      this.logger.warn(
        `instruction lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}
