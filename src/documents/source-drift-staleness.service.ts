/**
 * STALENESS BY SOURCE DRIFT, not by calendar.
 *
 * A recency check asks "how old is this claim?". That is the wrong
 * question for a domain with an external system of record. A `decided`
 * fact from 2019 is not stale — it is a statement about 2019, and it is
 * exactly as true today. A `depends_on_version` fact from yesterday IS
 * stale if someone merged a bump this morning. Age is noise; DRIFT is
 * the signal.
 *
 * So this service asks the only question that means anything for a
 * derivable claim: is the revision it was read at still the source's
 * current revision? A fact whose `source.sourceVersion.version` no
 * longer matches goes back for re-verification.
 *
 * NO GIT LIVES HERE. The server never resolves a ref, never shells out,
 * never opens a repository — it cannot, and should not be able to. The
 * CURRENT version is told to it by the party that already has the
 * working tree: the indexer, on its next submission. That keeps the
 * asymmetry honest — the external system of record stays external.
 *
 * WHICH FACTS ARE DERIVABLE IS DECLARED, NOT INFERRED. The predicate
 * class comes from the pack's own manifest
 * (`memoryModel.verificationRules` entries with
 * `requires: 'source_version_match'`), so a domain that knows its own
 * ontology decides what rots. The engine never pattern-matches predicate
 * names.
 *
 * MARKING, NOT ACTING — the 0072 contract, word for word: "this
 * migration marks, and a recompute pass acts". A drifted fact keeps
 * serving (a stale answer beats the nothing that hiding it would leave)
 * and carries `staleAt`/`staleReason` so a re-verification pass can find
 * it. The EXISTING staleness fields carry it with no schema change: they
 * are plain option<datetime>/option<string> columns on knowledge_fact
 * with their own index (fact_stale_idx), and the only consumer that
 * scans them — the recompose pass — is fenced to
 * `source.kind = 'compaction-summary'`, so drift marks are visible to a
 * re-verification pass without being swept into summary recomposition.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { MemoryModelReaderService } from '../ai/memory-model-reader.service';
import { composePredicateId } from '../ai/domain-packs/manifest';
import { packSourceVersionStalenessEnabled } from '../common/pack-projection-flags';
import type { SourceVersionStamp } from '../common/source-version';

/** `staleReason` written by this sweep — the fence the clear leg reads. */
export const SOURCE_DRIFT_REASON = 'source_version_drift';

/** Rows touched per sweep. A submission must not turn into an unbounded
 *  tenant-wide write; the next run picks up the remainder. */
const SWEEP_LIMIT = 500;

export interface DriftSweepResult {
  /** Facts newly marked stale by this sweep. */
  marked: number;
  /** Facts whose mark this sweep cleared (they are back at `current`). */
  cleared: number;
  /** Namespaced predicates the pack declared as derivable. */
  predicates: string[];
}

const NO_OP: DriftSweepResult = { marked: 0, cleared: 0, predicates: [] };

@Injectable()
export class SourceDriftStalenessService {
  private readonly logger = new Logger(SourceDriftStalenessService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly memoryModels: MemoryModelReaderService,
  ) {}

  /**
   * The pack's DERIVABLE predicate class, namespaced — read from the
   * installed manifest's memoryModel, never from a hardcoded list. A
   * pack that declared no `source_version_match` rule yields [], and the
   * sweep is a no-op for it (an interpretation-only domain never
   * drifts).
   */
  async derivablePredicates(companyId: string, packId: string): Promise<string[]> {
    const bindings = await this.memoryModels.installedMemoryModels(companyId);
    const model = bindings.find((b) => b.packId === packId)?.memoryModel;
    const locals = new Set<string>();
    for (const rule of model?.verificationRules ?? []) {
      if (rule.requires !== 'source_version_match') continue;
      for (const local of rule.appliesTo ?? []) locals.add(local);
    }
    return [...locals].map((local) => composePredicateId(packId, local));
  }

  /**
   * Mark the pack's derivable facts that were read at a DIFFERENT
   * revision of the same source line, and clear the marks this sweep
   * itself left on facts that are back at `current`.
   *
   * Flag off ⇒ returns without running a single query.
   */
  async sweep(p: {
    companyId: string;
    packId: string;
    current: SourceVersionStamp;
  }): Promise<DriftSweepResult> {
    if (!packSourceVersionStalenessEnabled()) return NO_OP;
    const predicates = await this.derivablePredicates(p.companyId, p.packId);
    if (predicates.length === 0) return NO_OP;
    try {
      return await this.surreal.withCompany(p.companyId, async (db) => {
        const marked = await this.mark(db, predicates, p.current);
        const cleared = await this.clear(db, predicates, p.current);
        return { marked, cleared, predicates };
      });
    } catch (e) {
      // A drift sweep is a maintenance signal riding a submission that
      // has ALREADY staged its candidates. Failing the submission over
      // it would lose real work to a bookkeeping error.
      this.logger.warn(`source-drift sweep failed (non-fatal): ${(e as Error).message}`);
      return { ...NO_OP, predicates };
    }
  }

  /**
   * SurrealDB 3.2.4 discipline: SELECT the ids, then write BY id.
   * `staleAt` is covered by fact_stale_idx and `predicate` by
   * fact_predicate_idx, and an UPDATE ... WHERE over an indexed field is
   * the reproduced silent planner no-op (the 0116 header, the
   * support-edge mirror). The LET-select-ids → UPDATE $ids form is a
   * primary-key write and is immune to it.
   *
   * The comparison is fenced to the SAME system AND the SAME ref: a fact
   * read on `main` says nothing about `release/2.x`, and a git commit is
   * not comparable with a DMS revision at all. Facts on another line are
   * left alone rather than marked on a false comparison. `staleAt IS
   * NONE` makes the sweep idempotent exactly as it does in
   * fn::mark_derived_stale, and `status = 'active'` keeps history
   * (superseded/compacted rows) out of it — a superseded fact is already
   * not the current answer.
   */
  private async mark(
    db: Surreal,
    predicates: string[],
    current: SourceVersionStamp,
  ): Promise<number> {
    return countWritten(
      db,
      `LET $ids = (SELECT VALUE id FROM knowledge_fact
         WHERE predicate INSIDE $predicates
           AND status = 'active'
           AND retractedAt IS NONE
           AND staleAt IS NONE
           AND source.sourceVersion.system = $system
           AND source.sourceVersion.ref = $ref
           AND source.sourceVersion.version != $version
         LIMIT ${SWEEP_LIMIT});
       UPDATE $ids SET staleAt = time::now(), staleReason = $reason RETURN id;`,
      {
        predicates,
        system: current.system,
        ref: current.ref,
        version: current.version,
        reason: SOURCE_DRIFT_REASON,
      },
    );
  }

  /**
   * The other half of honesty: a fact re-read at the CURRENT revision is
   * no longer drifted, so its mark goes away. Fenced to `staleReason =
   * SOURCE_DRIFT_REASON` — this sweep clears only what this sweep wrote,
   * never a derived-parent mark left by fn::mark_derived_stale (which
   * means something entirely different and is a different pass's to
   * clear).
   */
  private async clear(
    db: Surreal,
    predicates: string[],
    current: SourceVersionStamp,
  ): Promise<number> {
    return countWritten(
      db,
      `LET $ids = (SELECT VALUE id FROM knowledge_fact
         WHERE predicate INSIDE $predicates
           AND status = 'active'
           AND retractedAt IS NONE
           AND staleReason = $reason
           AND source.sourceVersion.system = $system
           AND source.sourceVersion.ref = $ref
           AND source.sourceVersion.version = $version
         LIMIT ${SWEEP_LIMIT});
       UPDATE $ids SET staleAt = NONE, staleReason = NONE RETURN id;`,
      {
        predicates,
        system: current.system,
        ref: current.ref,
        version: current.version,
        reason: SOURCE_DRIFT_REASON,
      },
    );
  }
}

/**
 * Rows written by the LAST statement of a multi-statement query. The
 * LET-select-ids form means the FIRST result belongs to the LET, so the
 * queryRows helper (which reads result 0) would report the selection,
 * not the write.
 */
async function countWritten(
  db: Surreal,
  sql: string,
  vars: Record<string, unknown>,
): Promise<number> {
  const results = (await db.query(sql, vars)) as unknown[];
  const last = results[results.length - 1];
  return Array.isArray(last) ? last.length : 0;
}
