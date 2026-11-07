import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';

/**
 * A person's consent, per purpose (#909 step 3, migration 0187).
 *
 * Install-time consent is the operator's; processing that infers how a
 * person feels needs the PERSON's — explicit when it may reveal health
 * (GDPR art. 9(2)(a), LGPD art. 11), recorded with the notice they saw,
 * and withdrawable as easily as it was given (art. 7(3)). A writer that
 * processes for a purpose asks `isActive` before it writes; withdrawal
 * stops it and runs the purpose's revocation handler, which erases what
 * the processing produced — the purpose's owner registers it
 * (registerRevocationHandler), so this service names no purpose itself.
 */
export const CONSENT_BASES = [
  'consent',
  'explicit_consent',
  'contract',
  'legal_obligation',
  'vital_interests',
  'public_task',
  'legitimate_interests',
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

/** A purpose name: lowercase snake_case, as a scope or a pack id. */
const PURPOSE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Whose grant it is: the person's own, or their guardian's (0189). */
export type ConsentGrantor = 'person' | 'guardian';

export interface ConsentWire {
  consentId: string;
  userId: string;
  purpose: string;
  grantedBy: ConsentGrantor;
  basis: ConsentBasis;
  noticeVersion: string;
  grantedAt: string;
  revokedAt?: string;
  active: boolean;
}

/** What withdrawing a purpose erased, by kind (counts only). */
export type RevocationErasure = Record<string, number>;

export interface ConsentRevocationHandler {
  /** Erase what processing for this purpose produced for the person. */
  onRevoke(companyId: string, userId: string): Promise<RevocationErasure>;
}

interface ConsentRow {
  id: unknown;
  userId: string;
  purpose: string;
  grantedBy?: ConsentGrantor | null;
  basis: ConsentBasis;
  noticeVersion: string;
  grantedAt: Date | string;
  revokedAt?: Date | string | null;
}

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);
  private readonly handlers = new Map<string, ConsentRevocationHandler>();

  constructor(private readonly surreal: SurrealService) {}

  /** The owner of a purpose registers what its withdrawal erases. */
  registerRevocationHandler(purpose: string, handler: ConsentRevocationHandler): void {
    this.handlers.set(purpose, handler);
  }

  /** Grant: the live grant for (user, purpose) is replaced, its history kept. */
  async record(opts: {
    companyId: string;
    userId: string;
    purpose: string;
    basis: string;
    noticeVersion: string;
    recordedBy?: string | undefined;
    /** 'guardian' needs a guardian on record (0189); the default is the person's own. */
    grantedBy?: ConsentGrantor | undefined;
  }): Promise<ConsentWire> {
    const purpose = checkPurpose(opts.purpose);
    const grantedBy: ConsentGrantor = opts.grantedBy ?? 'person';
    if (grantedBy !== 'person' && grantedBy !== 'guardian') {
      throw new BadRequestException("grantedBy must be 'person' or 'guardian'");
    }
    if (!(CONSENT_BASES as readonly string[]).includes(opts.basis)) {
      throw new BadRequestException(`basis must be one of ${CONSENT_BASES.join('|')}`);
    }
    const noticeVersion = opts.noticeVersion?.trim();
    if (!noticeVersion || noticeVersion.length > 128) {
      throw new BadRequestException('noticeVersion is required (≤128 chars)');
    }
    return this.surreal.withCompany(opts.companyId, async (db) => {
      if (grantedBy === 'guardian') {
        const guardian = await queryRows<unknown>(
          db,
          `SELECT VALUE id FROM guardian_link WHERE userId = $u LIMIT 1`,
          { u: opts.userId },
        );
        if (guardian.length === 0) {
          throw new BadRequestException('no guardian on record for this person');
        }
      }
      const [, created] = await db.query<[unknown, ConsentRow[]]>(
        `UPDATE consent_record SET revokedAt = time::now()
           WHERE userId = $u AND purpose = $p AND revokedAt IS NONE
             AND (grantedBy ?? 'person') = $g;
         CREATE consent_record CONTENT {
           userId: $u, purpose: $p, basis: $b, noticeVersion: $n,
           recordedBy: $by, grantedBy: $g
         };`,
        {
          u: opts.userId,
          p: purpose,
          b: opts.basis,
          n: noticeVersion,
          by: opts.recordedBy,
          g: grantedBy,
        },
      );
      const row = (created ?? [])[0];
      if (!row) throw new Error('consent_record create returned nothing');
      this.logger.log(`consent granted ${opts.companyId}: purpose=${purpose}`);
      return toWire(row);
    });
  }

  /** Withdraw: stamps the live grant and erases what the purpose produced. */
  async revoke(opts: {
    companyId: string;
    userId: string;
    purpose: string;
  }): Promise<{ purpose: string; revoked: boolean; erased: RevocationErasure }> {
    const purpose = checkPurpose(opts.purpose);
    const revoked = await this.surreal.withCompany(opts.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `UPDATE consent_record SET revokedAt = time::now()
           WHERE userId = $u AND purpose = $p AND revokedAt IS NONE RETURN id`,
        { u: opts.userId, p: purpose },
      );
      return (rows ?? []).length > 0;
    });
    // Erase whether or not a live grant was found: a withdrawal must leave
    // nothing behind even when the grant was already gone.
    const handler = this.handlers.get(purpose);
    const erased = handler ? await handler.onRevoke(opts.companyId, opts.userId) : {};
    this.logger.log(`consent withdrawn ${opts.companyId}: purpose=${purpose} revoked=${revoked}`);
    return { purpose, revoked, erased };
  }

  /** Every grant the person made, newest first (revoked ones included). */
  async list(opts: { companyId: string; userId: string }): Promise<ConsentWire[]> {
    return this.surreal.withCompany(opts.companyId, async (db) => {
      const rows = await queryRows<ConsentRow>(
        db,
        `SELECT id, userId, purpose, grantedBy, basis, noticeVersion, grantedAt, revokedAt
           FROM consent_record WHERE userId = $u ORDER BY grantedAt DESC LIMIT 200`,
        { u: opts.userId },
      );
      return rows.map(toWire);
    });
  }

  /**
   * Whether processing for the purpose may run for this person: a live
   * grant — and for a person recorded as a minor (0189), a live grant from
   * their guardian, with the guardian still on record. A child's own grant
   * never counts.
   */
  async isActive(companyId: string, userId: string, purpose: string): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [grants, minor, guardian] = await db.query<[string[], boolean[], unknown[]]>(
        `SELECT VALUE (grantedBy ?? 'person') FROM consent_record
           WHERE userId = $u AND purpose = $p AND revokedAt IS NONE;
         SELECT VALUE minor FROM user_age WHERE userId = $u LIMIT 1;
         SELECT VALUE id FROM guardian_link WHERE userId = $u LIMIT 1;`,
        { u: userId, p: purpose },
      );
      const live = grants ?? [];
      if ((minor ?? [])[0] === true) {
        return live.includes('guardian') && (guardian ?? []).length > 0;
      }
      return live.length > 0;
    });
  }

  /**
   * A person's standing changed (recorded as a minor, guardian removed):
   * every purpose they hold a grant for that no longer counts has what it
   * produced erased — inference made on a child's own consent must go.
   */
  async reconcile(companyId: string, userId: string): Promise<Record<string, RevocationErasure>> {
    const purposes = await this.surreal.withCompany(companyId, (db) =>
      queryRows<string>(
        db,
        `SELECT VALUE purpose FROM consent_record WHERE userId = $u AND revokedAt IS NONE`,
        { u: userId },
      ),
    );
    const erased: Record<string, RevocationErasure> = {};
    for (const purpose of new Set(purposes)) {
      if (await this.isActive(companyId, userId, purpose)) continue;
      const handler = this.handlers.get(purpose);
      if (handler) erased[purpose] = await handler.onRevoke(companyId, userId);
    }
    return erased;
  }
}

function checkPurpose(raw: string): string {
  const purpose = raw?.trim();
  if (!purpose || !PURPOSE_RE.test(purpose)) {
    throw new BadRequestException('purpose must be lowercase snake_case (≤64 chars)');
  }
  return purpose;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toWire(row: ConsentRow): ConsentWire {
  const revokedAt = row.revokedAt ? iso(row.revokedAt) : undefined;
  return {
    consentId: String(row.id),
    userId: row.userId,
    purpose: row.purpose,
    grantedBy: row.grantedBy === 'guardian' ? 'guardian' : 'person',
    basis: row.basis,
    noticeVersion: row.noticeVersion,
    grantedAt: iso(row.grantedAt),
    ...(revokedAt ? { revokedAt } : {}),
    active: revokedAt === undefined,
  };
}
