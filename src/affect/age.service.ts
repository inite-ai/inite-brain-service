import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { ConsentService, type RevocationErasure } from './consent.service';

export const AGE_STATUSES = ['declared', 'estimated', 'verified'] as const;
export const AGE_BANDS = ['under_13', '13_15', '16_17', 'adult'] as const;

export interface AgeWire {
  userId: string;
  status: (typeof AGE_STATUSES)[number];
  minor: boolean;
  ageBand?: (typeof AGE_BANDS)[number];
  method?: string;
  assuredAt: string;
  guardian?: { guardianRef: string; verifiedAt: string };
}

interface AgeRow {
  userId: string;
  status: AgeWire['status'];
  minor: boolean;
  ageBand?: AgeWire['ageBand'] | null;
  method?: string | null;
  assuredAt: Date | string;
}

/**
 * What the memory knows about a person's age, and who their guardian is
 * (#916 step 1, migration 0189). The operator records both — the
 * threshold of minority differs by jurisdiction, so brain keeps the
 * outcome (`minor`), how sure it is, and an optional coarse band; never a
 * birth date, never a guardian's identity (an opaque reference).
 *
 * Every change re-checks the person's consents (ConsentService.reconcile):
 * recorded as a minor, or their guardian removed, a grant that no longer
 * counts has what it produced erased.
 */
@Injectable()
export class AgeService {
  private readonly logger = new Logger(AgeService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly consents: ConsentService,
  ) {}

  async get(companyId: string, userId: string): Promise<AgeWire | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [ages, guardians] = await db.query<
        [AgeRow[], Array<{ guardianRef: string; verifiedAt: Date | string }>]
      >(
        `SELECT userId, status, minor, ageBand, method, assuredAt FROM user_age WHERE userId = $u LIMIT 1;
         SELECT guardianRef, verifiedAt FROM guardian_link WHERE userId = $u LIMIT 1;`,
        { u: userId },
      );
      const age = (ages ?? [])[0];
      if (!age) return null;
      const g = (guardians ?? [])[0];
      return {
        userId,
        status: age.status,
        minor: age.minor,
        ...(age.ageBand ? { ageBand: age.ageBand } : {}),
        ...(age.method ? { method: age.method } : {}),
        assuredAt: iso(age.assuredAt),
        ...(g ? { guardian: { guardianRef: g.guardianRef, verifiedAt: iso(g.verifiedAt) } } : {}),
      };
    });
  }

  async set(opts: {
    companyId: string;
    userId: string;
    status: string;
    minor: unknown;
    ageBand?: string | undefined;
    method?: string | undefined;
    recordedBy?: string | undefined;
  }): Promise<{ age: AgeWire; erased: Record<string, RevocationErasure> }> {
    if (!(AGE_STATUSES as readonly string[]).includes(opts.status)) {
      throw new BadRequestException(`status must be one of ${AGE_STATUSES.join('|')}`);
    }
    if (typeof opts.minor !== 'boolean')
      throw new BadRequestException('minor must be true or false');
    if (opts.ageBand !== undefined && !(AGE_BANDS as readonly string[]).includes(opts.ageBand)) {
      throw new BadRequestException(`ageBand must be one of ${AGE_BANDS.join('|')}`);
    }
    if (opts.ageBand === 'adult' && opts.minor) {
      throw new BadRequestException("ageBand 'adult' contradicts minor: true");
    }
    await this.surreal.withCompany(opts.companyId, async (db) => {
      await db.query(
        `LET $old = (SELECT VALUE id FROM user_age WHERE userId = $u);
         DELETE $old;
         CREATE user_age CONTENT {
           userId: $u, status: $s, minor: $m, ageBand: $b, method: $meth, recordedBy: $by };`,
        {
          u: opts.userId,
          s: opts.status,
          m: opts.minor,
          b: opts.ageBand,
          meth: opts.method?.slice(0, 64),
          by: opts.recordedBy,
        },
      );
    });
    const erased = await this.consents.reconcile(opts.companyId, opts.userId);
    this.logger.log(
      `age recorded ${opts.companyId}: status=${opts.status} minor=${String(opts.minor)}`,
    );
    return { age: (await this.get(opts.companyId, opts.userId))!, erased };
  }

  async setGuardian(opts: {
    companyId: string;
    userId: string;
    guardianRef: string;
    recordedBy?: string | undefined;
  }): Promise<AgeWire | null> {
    const ref = opts.guardianRef?.trim();
    if (!ref || ref.length > 200)
      throw new BadRequestException('guardianRef is required (≤200 chars)');
    await this.surreal.withCompany(opts.companyId, async (db) => {
      await db.query(
        `LET $old = (SELECT VALUE id FROM guardian_link WHERE userId = $u);
         DELETE $old;
         CREATE guardian_link CONTENT { userId: $u, guardianRef: $g, recordedBy: $by };`,
        { u: opts.userId, g: ref, by: opts.recordedBy },
      );
    });
    return this.get(opts.companyId, opts.userId);
  }

  /** Remove the guardian: a minor's guardian grants stop counting, and what they allowed is erased. */
  async removeGuardian(
    companyId: string,
    userId: string,
  ): Promise<{ removed: boolean; erased: Record<string, RevocationErasure> }> {
    const removed = await this.surreal.withCompany(companyId, async (db) => {
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM guardian_link WHERE userId = $u`,
        { u: userId },
      );
      if (ids.length > 0) await db.query(`DELETE $ids`, { ids });
      return ids.length > 0;
    });
    return { removed, erased: await this.consents.reconcile(companyId, userId) };
  }
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
