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

export interface ConsentWire {
  consentId: string;
  userId: string;
  purpose: string;
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
  }): Promise<ConsentWire> {
    const purpose = checkPurpose(opts.purpose);
    if (!(CONSENT_BASES as readonly string[]).includes(opts.basis)) {
      throw new BadRequestException(`basis must be one of ${CONSENT_BASES.join('|')}`);
    }
    const noticeVersion = opts.noticeVersion?.trim();
    if (!noticeVersion || noticeVersion.length > 128) {
      throw new BadRequestException('noticeVersion is required (≤128 chars)');
    }
    return this.surreal.withCompany(opts.companyId, async (db) => {
      const [, created] = await db.query<[unknown, ConsentRow[]]>(
        `UPDATE consent_record SET revokedAt = time::now()
           WHERE userId = $u AND purpose = $p AND revokedAt IS NONE;
         CREATE consent_record CONTENT {
           userId: $u, purpose: $p, basis: $b, noticeVersion: $n,
           recordedBy: $by
         };`,
        {
          u: opts.userId,
          p: purpose,
          b: opts.basis,
          n: noticeVersion,
          by: opts.recordedBy,
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
        `SELECT id, userId, purpose, basis, noticeVersion, grantedAt, revokedAt
           FROM consent_record WHERE userId = $u ORDER BY grantedAt DESC LIMIT 200`,
        { u: opts.userId },
      );
      return rows.map(toWire);
    });
  }

  /** Whether the person holds a live grant for the purpose. */
  async isActive(companyId: string, userId: string, purpose: string): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM consent_record
           WHERE userId = $u AND purpose = $p AND revokedAt IS NONE LIMIT 1`,
        { u: userId, p: purpose },
      );
      return rows.length > 0;
    });
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
    basis: row.basis,
    noticeVersion: row.noticeVersion,
    grantedAt: iso(row.grantedAt),
    ...(revokedAt ? { revokedAt } : {}),
    active: revokedAt === undefined,
  };
}
