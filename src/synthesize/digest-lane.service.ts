import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { ReadPinService, derivedVersionFence } from '../episodes/read-pin.service';

/** Newest digests surfaced per answer — one per conversation; multi-
 *  conversation tenants get the most recently active few. */
const DIGEST_LIMIT = 4;

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
 * non-null episode userIds of the folded window. A tenant-global
 * caller (no userId — today's M2M surface) reads everything,
 * unchanged. A user-scoped caller reads fail-closed: only digests
 * whose userScopes is empty/NONE (purely tenant-global content) or
 * exactly [that user] — a digest folded from ANY other user's turns
 * (mixed-scope included) is never exposed.
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
     *  caller, no user gate (M2M reads the whole tenant today). */
    userId?: string | undefined;
  }): Promise<string[]> {
    try {
      const derivedVersion =
        (await this.readPin?.resolveRead(opts.companyId)) ?? ReadPinService.bootstrapRead();
      const fence = derivedVersionFence(derivedVersion);
      // The fence clause is 'AND'-prefixed for splicing after other
      // filters; this WHERE has none, so strip the connective.
      const worldGate = fence.clause.replace(/^AND /, '');
      // 0087 fail-closed user gate: a user-scoped caller sees only
      // purely tenant-global digests (userScopes empty/NONE) or
      // digests scoped to exactly [that user] — never a digest whose
      // fold touched another user's turns.
      const userGate = opts.userId
        ? `AND (userScopes IS NONE
              OR array::len(userScopes) = 0
              OR userScopes = [$digestUserId])`
        : '';
      const params = opts.userId ? { ...fence.params, digestUserId: opts.userId } : fence.params;
      const rows = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [out] = await db.query<[Array<{ summary: string; lastEventAt: Date | string }>]>(
          `SELECT summary, lastEventAt FROM conversation_digest
              WHERE ${worldGate}
              ${userGate}
              ORDER BY lastEventAt DESC
              LIMIT ${DIGEST_LIMIT}`,
          params,
        );
        return out ?? [];
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
}
