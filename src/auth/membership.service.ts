import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { parseTeamTag, teamTag, userTag } from './scope-tags';

/**
 * The membership plane (G6 step 3–5, W5): who a brain user IS in the
 * systems a connection reads, and therefore which `team:` tags they
 * hold.
 *
 * Three rules this service exists to keep:
 *
 *  1. **Unlinked is nobody.** An external account nobody has linked to a
 *     brain user grants no visibility at all. Guessing a link (by
 *     display name, by a look-alike address) is how ACL mirrors leak,
 *     so the only automatic link is an address that ANOTHER identity in
 *     this tenant is already linked by — a link an operator once made,
 *     followed to a second system.
 *  2. **Revocation is a timestamp.** A membership that ends is stamped,
 *     never deleted: a bitemporal store has to be able to say when
 *     someone stopped being a member, and a delete makes March
 *     unanswerable.
 *  3. **Every change bumps the epoch.** The new-enemy problem: an
 *     expansion cached before a revocation would keep letting its holder
 *     read. Every cache of an expansion keys on `scope_epoch`, and every
 *     write here moves it — so a stale expansion cannot survive the
 *     write that invalidates it.
 *
 * Expansion is bounded: a subject's tags are the groups it is a member
 * of, plus the groups THOSE groups are members of, to `MAX_DEPTH` — a
 * nested-group cycle terminates instead of hanging (a G6 failure mode
 * named in the design).
 */
export interface MembershipTuple {
  subject: string;
  object: string;
  connectionId: string;
  source: string;
  recordedAt: string;
  revokedAt: string | null;
}

interface TupleRow extends Omit<MembershipTuple, 'recordedAt' | 'revokedAt'> {
  recordedAt: unknown;
  revokedAt: unknown;
}

export interface ExternalIdentityRow {
  connectionId: string;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  userId: string | null;
  linkedBy: string | null;
}

/** One account a connector saw, as the sync reports it. */
export interface SeenIdentity {
  externalId: string;
  handle?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
}

const MAX_DEPTH = 8;
const MAX_TAGS = 512;
const EPOCH_ID = 'scope_epoch:current';

@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);
  /** companyId → { epoch, byUser } — dropped whole the moment the epoch moves. */
  private readonly cache = new Map<string, { epoch: number; byUser: Map<string, string[]> }>();

  constructor(private readonly surreal: SurrealService) {}

  /** The tenant's consistency token. Every expansion is cached against it. */
  async epoch(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ epoch: number }>]>(`SELECT epoch FROM ${EPOCH_ID}`);
      return rows?.[0]?.epoch ?? 0;
    });
  }

  /**
   * The tags `userId` holds: their own `user:` tag plus every group they
   * are an unrevoked member of, transitively. Cached per tenant against
   * the epoch — a membership write drops the whole tenant's cache, which
   * is the cheap, correct answer for a token that moves rarely.
   */
  async tagsFor(companyId: string, userId: string): Promise<string[]> {
    const epoch = await this.epoch(companyId);
    const hit = this.cache.get(companyId);
    if (hit && hit.epoch === epoch) {
      const cached = hit.byUser.get(userId);
      if (cached) return cached;
    }
    const tags = await this.expand(companyId, userTag(userId));
    const bucket =
      hit && hit.epoch === epoch ? hit : { epoch, byUser: new Map<string, string[]>() };
    bucket.byUser.set(userId, tags);
    this.cache.set(companyId, bucket);
    return tags;
  }

  /** The transitive closure of `member` from one subject, cycle-guarded. */
  private async expand(companyId: string, subject: string): Promise<string[]> {
    const held = new Set<string>([subject]);
    let frontier = [subject];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const groups = await this.surreal.withCompany(companyId, async (db) => {
        const [rows] = await db.query<[Array<{ object: string }>]>(
          `SELECT object FROM external_principal
            WHERE subject IN $subjects AND relation = 'member' AND revokedAt IS NONE`,
          { subjects: frontier },
        );
        return rows ?? [];
      });
      const next: string[] = [];
      for (const row of groups) {
        // A group tag that does not parse is not a group: it is never
        // held, so a malformed tuple cannot widen anyone.
        if (parseTeamTag(row.object) === null) continue;
        if (held.has(row.object)) continue;
        if (held.size >= MAX_TAGS) {
          this.logger.warn(`scope expansion for ${subject} hit the tag cap (${String(MAX_TAGS)})`);
          return [...held];
        }
        held.add(row.object);
        next.push(row.object);
      }
      frontier = next;
    }
    return [...held];
  }

  /** Every identity a connection has seen, newest link first. */
  async identities(companyId: string, connectionId: string): Promise<ExternalIdentityRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<Partial<ExternalIdentityRow>>]>(
        `SELECT connectionId, externalId, handle, displayName,
                email, userId, linkedBy
           FROM external_identity WHERE connectionId = $connectionId
           ORDER BY externalId ASC LIMIT 1000`,
        { connectionId },
      );
      // A NONE column comes back ABSENT, not null — the wire contract
      // says null, and "nobody has linked this account" is a value.
      return (rows ?? []).map((r) => ({
        connectionId,
        externalId: r.externalId ?? '',
        handle: r.handle ?? null,
        displayName: r.displayName ?? null,
        email: r.email ?? null,
        userId: r.userId ?? null,
        linkedBy: r.linkedBy ?? null,
      }));
    });
  }

  /** The unrevoked tuples of one connection (what the admin surface shows). */
  async tuplesOf(companyId: string, connectionId: string): Promise<MembershipTuple[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[TupleRow[]]>(
        `SELECT subject, object, connectionId, source, recordedAt, revokedAt
           FROM external_principal WHERE connectionId = $connectionId
           ORDER BY object ASC LIMIT 2000`,
        { connectionId },
      );
      return (rows ?? []).map((r) => ({
        ...r,
        recordedAt: String(r.recordedAt),
        revokedAt: r.revokedAt === null || r.revokedAt === undefined ? null : String(r.revokedAt),
      }));
    });
  }

  /**
   * Record the accounts a sync saw. Returns the identities as they now
   * stand, auto-linking an account whose address another identity in
   * this tenant is already linked by — never inventing a link of its
   * own.
   */
  async seeIdentities(
    companyId: string,
    connectionId: string,
    seen: readonly SeenIdentity[],
  ): Promise<ExternalIdentityRow[]> {
    for (const s of seen) {
      const email = s.email?.trim().toLowerCase();
      await this.surreal.withCompany(companyId, async (db) => {
        const [existing] = await db.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM external_identity
            WHERE connectionId = $connectionId AND externalId = $externalId LIMIT 1`,
          { connectionId, externalId: s.externalId },
        );
        // ⚡Surreal's `option<string>` takes NONE, never NULL: an absent
        // key is the only way to say "the source did not tell us".
        const patch = {
          ...(s.handle !== undefined ? { handle: s.handle } : {}),
          ...(s.displayName !== undefined ? { displayName: s.displayName } : {}),
          ...(email !== undefined ? { email } : {}),
          lastSeenAt: new Date(),
        };
        const found = existing?.[0]?.id;
        if (found) {
          await db.query(`UPDATE $id MERGE $patch`, { id: found, patch });
          return;
        }
        await db.query(`CREATE external_identity CONTENT $row`, {
          row: { connectionId, externalId: s.externalId, ...patch },
        });
      });
      if (email) {
        await this.linkByEmail({ companyId, connectionId, externalId: s.externalId, email });
      }
    }
    return this.identities(companyId, connectionId);
  }

  /**
   * An account whose address another LINKED identity already carries is
   * the same person — the one automatic link, and it only ever follows a
   * link an operator made.
   */
  private async linkByEmail(p: {
    companyId: string;
    connectionId: string;
    externalId: string;
    email: string;
  }): Promise<void> {
    const { companyId, connectionId, externalId, email } = p;
    const userId = await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ userId: string | null }>]>(
        `SELECT userId FROM external_identity
          WHERE email = $email AND userId IS NOT NONE LIMIT 1`,
        { email },
      );
      return rows?.[0]?.userId ?? null;
    });
    if (!userId) return;
    await this.link({ companyId, connectionId, externalId, userId, linkedBy: 'email' });
  }

  /**
   * Link an account to a brain user (an operator's decision, or the
   * address match above). Re-runs the connection's tuples so the new
   * user inherits the groups the account is already in, and bumps the
   * epoch.
   */
  async link(p: {
    companyId: string;
    connectionId: string;
    externalId: string;
    userId: string | null;
    linkedBy: 'operator' | 'email';
  }): Promise<void> {
    const { companyId, connectionId, externalId, userId, linkedBy } = p;
    const before = await this.subjectOf(companyId, connectionId, externalId);
    await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM external_identity
          WHERE connectionId = $connectionId AND externalId = $externalId LIMIT 1`,
        { connectionId, externalId },
      );
      const id = rows?.[0]?.id;
      if (!id) throw new Error(`no such identity: ${externalId}`);
      if (userId) {
        await db.query(`UPDATE $id MERGE $patch`, {
          id,
          patch: { userId, linkedBy, linkedAt: new Date() },
        });
      } else {
        await db.query(`UPDATE $id SET userId = NONE, linkedBy = NONE, linkedAt = NONE`, { id });
      }
    });
    // The account's groups move with the person: what the OLD user held
    // through this account is revoked, what the new one holds is written.
    const groups = await this.groupsOfIdentity(companyId, connectionId, externalId);
    if (before && before !== userId) {
      await this.setMemberships({
        companyId,
        connectionId,
        subject: userTag(before),
        groups: [],
        source: 'operator',
      });
    }
    if (userId) {
      await this.setMemberships({
        companyId,
        connectionId,
        subject: userTag(userId),
        groups,
        source: 'operator',
      });
    }
    await this.bump(companyId, `link ${externalId}`);
  }

  private async subjectOf(
    companyId: string,
    connectionId: string,
    externalId: string,
  ): Promise<string | null> {
    const rows = await this.identities(companyId, connectionId);
    return rows.find((r) => r.externalId === externalId)?.userId ?? null;
  }

  /** The groups one account is recorded in (by its own account subject). */
  private async groupsOfIdentity(
    companyId: string,
    connectionId: string,
    externalId: string,
  ): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ object: string }>]>(
        `SELECT object FROM external_principal
          WHERE connectionId = $connectionId AND subject = $subject AND revokedAt IS NONE`,
        { connectionId, subject: accountSubject(connectionId, externalId) },
      );
      return (rows ?? []).map((r) => r.object);
    });
  }

  /**
   * Make one subject's membership of one connection's groups exactly
   * `groups`: write what is missing, stamp `revokedAt` on what is gone.
   * Returns true when anything changed.
   */
  async setMemberships(p: {
    companyId: string;
    connectionId: string;
    subject: string;
    groups: readonly string[];
    source: 'connector' | 'operator';
  }): Promise<boolean> {
    const { companyId, connectionId, subject, source } = p;
    const wanted = new Set(p.groups);
    return this.surreal.withCompany(companyId, async (db) => {
      const [current] = await db.query<
        [Array<{ id: unknown; object: string; revokedAt: unknown }>]
      >(
        `SELECT id, object, revokedAt FROM external_principal
          WHERE connectionId = $connectionId AND subject = $subject`,
        { connectionId, subject },
      );
      let changed = false;
      const now = new Date();
      for (const row of current ?? []) {
        const live = row.revokedAt === null || row.revokedAt === undefined;
        if (wanted.has(row.object)) {
          wanted.delete(row.object);
          if (!live) {
            await db.query(`UPDATE $id SET revokedAt = NONE, recordedAt = $now`, {
              id: row.id,
              now,
            });
            changed = true;
          }
          continue;
        }
        if (live) {
          await db.query(`UPDATE $id SET revokedAt = $now`, { id: row.id, now });
          changed = true;
        }
      }
      for (const object of wanted) {
        await db.query(`CREATE external_principal CONTENT $row`, {
          row: { subject, object, relation: 'member', connectionId, source },
        });
        changed = true;
      }
      return changed;
    });
  }

  /** Move the tenant's consistency token — every cached expansion dies with it. */
  async bump(companyId: string, reason: string): Promise<number> {
    const next = await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ epoch: number }>]>(
        `UPSERT ${EPOCH_ID} SET epoch += 1, changedAt = time::now(), reason = $reason
           RETURN epoch`,
        { reason: reason.slice(0, 120) },
      );
      return rows?.[0]?.epoch ?? 0;
    });
    this.cache.delete(companyId);
    return next;
  }

  /** Forget every cached expansion (tests, and a tenant being dropped). */
  forget(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }
}

/**
 * The tuple subject for an account nobody has linked yet — the groups it
 * is in are recorded against the ACCOUNT, so linking a person later
 * hands them the memberships already known instead of waiting for the
 * next sync.
 */
export function accountSubject(connectionId: string, externalId: string): string {
  return teamTag(connectionId, `account/${externalId}`);
}
