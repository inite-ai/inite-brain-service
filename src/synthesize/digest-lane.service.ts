import { actingCircleTags } from '../auth/circle-scope';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { pinUserScope } from '../auth/user-scope';
import { ReadPinService, derivedVersionFence } from '../episodes/read-pin.service';

/** Newest digests surfaced per answer — one per conversation; multi-
 *  conversation tenants get the most recently active few. */
const DIGEST_LIMIT = 4;

/** Candidates read before the PII screen drops some — enough that a few
 *  PII-touched conversations do not empty the lane. */
const DIGEST_CANDIDATES = DIGEST_LIMIT * 4;

/**
 * Digest lane (V12 §2 read side) — surfaces the rolling conversation
 * digests (conversation_digest, 0086; written under DERIVER_DIGEST)
 * into the prompt's insight slot. The digest is the dated narrative
 * arc summarization golds ask for; the collector merges these lines
 * ahead of the retrieved insight lines under the same budget slot, so
 * the generator, the verifier and the NLI judge all see it (evidence
 * parity by construction).
 *
 * Same contracts as the sibling lanes: derived-world pin resolved per
 * tenant, degrade to [] on any failure, no env reads. SCOPE POLICY
 * (0087, V11 item 10): digests carry userScopes — the distinct
 * non-null episode userIds of the folded window. Every caller reads
 * fail-closed: a tenant-global caller (no userId — the M2M surface)
 * reads only digests whose userScopes is empty/NONE, the same
 * "omitting userId never mixes in personal memory" rule every other
 * read surface keeps (before, it read every user's digests); a
 * user-scoped caller reads those plus digests scoped to exactly [that
 * user] — a digest folded from ANY other user's turns (mixed-scope
 * included) is never exposed.
 *
 * PII: a digest is a free-text fold of its conversation's turns and
 * records no piiClass of its own, so the lane cannot tell which lines
 * came from a PII-classed turn. A caller without brain:read_pii is
 * served no digest whose conversation holds any PII-classed episode —
 * the same rule the transcript lanes apply turn by turn, applied at the
 * granularity the digest has.
 */
@Injectable()
export class DigestLaneService {
  private readonly logger = new Logger(DigestLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly readPin?: ReadPinService,
  ) {}

  async digestLines(opts: {
    companyId: string;
    /** Scope key of the asking end-user; omitted → tenant-global
     *  caller, tenant-global digests only. */
    userId?: string | undefined;
    /** The caller holds brain:read_pii. Omitted → it does not. */
    includePii?: boolean | undefined;
  }): Promise<string[]> {
    // Trust circles §3.5: a digest folds whole conversations and carries no
    // scope tags — acting in a circle, the lane serves none.
    if (actingCircleTags().length > 0) return [];
    try {
      // A user-bound token is its user whether or not it named itself.
      const userId = pinUserScope(opts.userId);
      const derivedVersion =
        (await this.readPin?.resolveRead(opts.companyId)) ?? ReadPinService.bootstrapRead();
      const fence = derivedVersionFence(derivedVersion);
      // The fence clause is 'AND'-prefixed for splicing after other
      // filters; this WHERE has none, so strip the connective.
      const worldGate = fence.clause.replace(/^AND /, '');
      // 0087 fail-closed user gate: purely tenant-global digests
      // (userScopes empty/NONE), plus — for a user-scoped caller —
      // digests scoped to exactly [that user]; never a digest whose
      // fold touched another user's turns.
      const userGate = userId
        ? `AND (userScopes IS NONE
              OR array::len(userScopes) = 0
              OR userScopes = [$digestUserId])`
        : `AND (userScopes IS NONE OR array::len(userScopes) = 0)`;
      const params = userId ? { ...fence.params, digestUserId: userId } : fence.params;
      const rows = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [out] = await db.query<[DigestRow[]]>(
          `SELECT summary, lastEventAt, conversationId FROM conversation_digest
              WHERE ${worldGate}
              ${userGate}
              ORDER BY lastEventAt DESC
              LIMIT ${opts.includePii ? DIGEST_LIMIT : DIGEST_CANDIDATES}`,
          params,
        );
        const candidates = out ?? [];
        if (opts.includePii) return candidates;
        return (await this.withoutPiiConversations(db, candidates)).slice(0, DIGEST_LIMIT);
      });
      return rows
        .filter((r) => r.summary && r.summary.trim().length > 0)
        .map((r) => {
          const day =
            r.lastEventAt instanceof Date
              ? r.lastEventAt.toISOString().slice(0, 10)
              : String(r.lastEventAt).slice(0, 10);
          return `Conversation record (through ${day}):\n${r.summary}`;
        });
    } catch (e) {
      this.logger.warn(`digest lane failed (companyId=${opts.companyId}): ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Drop the digests whose conversation holds a PII-classed episode. One
   * indexed probe per conversation (episode (conversationId, occurredAt)),
   * batched in one round trip.
   */
  private async withoutPiiConversations(db: Surreal, rows: DigestRow[]): Promise<DigestRow[]> {
    const convs = [...new Set(rows.map((r) => r.conversationId).filter((c) => c !== undefined))];
    if (convs.length === 0) return rows;
    const sql = convs
      .map(
        (_c, i) =>
          `SELECT VALUE id FROM episode WHERE conversationId = $c${i} AND piiClass IS NOT NONE LIMIT 1;`,
      )
      .join('\n');
    const params = Object.fromEntries(convs.map((c, i) => [`c${i}`, c]));
    const results = await db.query<unknown[][]>(sql, params);
    const piiConvs = new Set(convs.filter((_c, i) => (results[i] ?? []).length > 0));
    return rows.filter((r) => r.conversationId === undefined || !piiConvs.has(r.conversationId));
  }
}

interface DigestRow {
  summary: string;
  lastEventAt: Date | string;
  conversationId?: string;
}
