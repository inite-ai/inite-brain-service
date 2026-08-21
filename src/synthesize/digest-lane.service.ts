import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import {
  ReadPinService,
  derivedVersionFence,
} from '../episodes/read-pin.service';

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
 * tenant, degrade to [] on any failure, no env reads. SCOPE NOTE:
 * digests are tenant-global derived state built from whole
 * conversations — there is no per-row pii/user gate to apply here.
 * Fine for the default-off eval leg; the production story belongs to
 * the policy-aware evidence context (V11 brief item 10) before any
 * default-on.
 */
@Injectable()
export class DigestLaneService {
  private readonly logger = new Logger(DigestLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly readPin?: ReadPinService,
  ) {}

  async digestLines(opts: { companyId: string }): Promise<string[]> {
    try {
      const derivedVersion =
        (await this.readPin?.resolveRead(opts.companyId)) ??
        ReadPinService.bootstrapRead();
      const fence = derivedVersionFence(derivedVersion);
      // The fence clause is 'AND'-prefixed for splicing after other
      // filters; this WHERE has none, so strip the connective.
      const worldGate = fence.clause.replace(/^AND /, '');
      const worldParams = fence.params;
      const rows = await this.surreal.withCompany(
        opts.companyId,
        async (db) => {
          const [out] = await db.query<
            [Array<{ summary: string; lastEventAt: Date | string }>]
          >(
            `SELECT summary, lastEventAt FROM conversation_digest
              WHERE ${worldGate}
              ORDER BY lastEventAt DESC
              LIMIT ${DIGEST_LIMIT}`,
            worldParams,
          );
          return out ?? [];
        },
      );
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
      this.logger.warn(
        `digest lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }
}
