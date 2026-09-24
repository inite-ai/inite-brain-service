import { Injectable, Logger } from '@nestjs/common';
import { MembershipService, accountSubject, type SeenIdentity } from '../auth/membership.service';
import { teamTag, userTag } from '../auth/scope-tags';
import { sourcePrincipalsEnabled } from '../common/source-plane-flags';
import type { Connector, ConnectorCtx, PrincipalDelta } from './connector';

/**
 * The membership walk (W5): run a connector's `principals()` and turn
 * what it saw into the tuples the read fence evaluates.
 *
 * Three things happen per group a connector reports, and the order is
 * the whole safety argument:
 *
 *  1. Every account is recorded as an IDENTITY, whether or not anybody
 *     knows who it is. An operator cannot link a person they cannot see,
 *     and a link is never guessed from a display name.
 *  2. The groups are written against the ACCOUNT's own subject, so a
 *     link made later inherits the memberships already known instead of
 *     waiting for the next sync.
 *  3. Only a LINKED account also writes the brain user's own tuple. An
 *     unlinked account grants nobody anything, which is what makes the
 *     failure mode of this whole plane "too little access" rather than
 *     "someone else's repository".
 *
 * A walk is always full: a group the source no longer reports, or a
 * member who left it, is revoked. That is the point of running it —
 * an ACL mirror that only ever adds is not a mirror.
 */
export interface PrincipalsSummary {
  groups: number;
  accounts: number;
  linked: number;
  changed: boolean;
  epoch: number;
}

const MAX_GROUPS = 500;
const MAX_ACCOUNTS = 20_000;

@Injectable()
export class SourcePrincipalsService {
  private readonly logger = new Logger(SourcePrincipalsService.name);

  constructor(private readonly membership: MembershipService) {}

  /** Whether this connection can mirror an ACL at all. */
  supported(connector: Connector, userId: string | null): boolean {
    return typeof connector.principals === 'function' && !userId;
  }

  /**
   * Walk one connection's principals and reconcile the tuples. A
   * personal connection is skipped: it is user-fenced by construction
   * and its source's groups mean nothing to the one person reading it.
   */
  async sync(p: { ctx: ConnectorCtx; connector: Connector }): Promise<PrincipalsSummary | null> {
    const { ctx, connector } = p;
    if (!sourcePrincipalsEnabled()) return null;
    if (!this.supported(connector, ctx.connection.userId)) return null;

    const groups = new Set<string>();
    const accounts = new Map<string, SeenIdentity>();
    const byAccount = new Map<string, Set<string>>();
    for await (const delta of connector.principals!(ctx)) {
      if (ctx.signal.aborted) throw new Error('aborted');
      collect({ delta, groups, accounts, byAccount, connectionId: ctx.connection.id });
      if (groups.size > MAX_GROUPS || accounts.size > MAX_ACCOUNTS) {
        // An ACL too big to mirror is a sync ERROR, never a silent
        // truncation to "fewer tags" — fewer tags is more access.
        throw new Error(
          `principals: ${ctx.connection.id} reports more than this engine mirrors ` +
            `(${String(groups.size)} groups, ${String(accounts.size)} accounts)`,
        );
      }
    }

    const identities = await this.membership.seeIdentities(ctx.companyId, ctx.connection.id, [
      ...accounts.values(),
    ]);
    const linkedBy = new Map(
      identities.filter((i) => i.userId).map((i) => [i.externalId, i.userId!]),
    );
    let changed = false;
    for (const [externalId, tags] of byAccount) {
      const subject = accountSubject(ctx.connection.id, externalId);
      const wrote = await this.membership.setMemberships({
        companyId: ctx.companyId,
        connectionId: ctx.connection.id,
        subject,
        groups: [...tags],
        source: 'connector',
      });
      changed = changed || wrote;
      const userId = linkedBy.get(externalId);
      if (!userId) continue;
      const asUser = await this.membership.setMemberships({
        companyId: ctx.companyId,
        connectionId: ctx.connection.id,
        subject: userTag(userId),
        groups: [...tags],
        source: 'connector',
      });
      changed = changed || asUser;
    }
    // An account the source no longer reports at all loses everything.
    for (const identity of identities) {
      if (byAccount.has(identity.externalId)) continue;
      const gone = await this.membership.setMemberships({
        companyId: ctx.companyId,
        connectionId: ctx.connection.id,
        subject: accountSubject(ctx.connection.id, identity.externalId),
        groups: [],
        source: 'connector',
      });
      changed = changed || gone;
      if (!identity.userId) continue;
      const user = await this.membership.setMemberships({
        companyId: ctx.companyId,
        connectionId: ctx.connection.id,
        subject: userTag(identity.userId),
        groups: [],
        source: 'connector',
      });
      changed = changed || user;
    }

    const epoch = changed
      ? await this.membership.bump(ctx.companyId, `principals ${ctx.connection.id}`)
      : await this.membership.epoch(ctx.companyId);
    const summary: PrincipalsSummary = {
      groups: groups.size,
      accounts: accounts.size,
      linked: linkedBy.size,
      changed,
      epoch,
    };
    ctx.log(
      `principals: ${String(summary.groups)} groups, ${String(summary.accounts)} accounts, ` +
        `${String(summary.linked)} linked${changed ? ` (epoch ${String(epoch)})` : ' (unchanged)'}`,
    );
    return summary;
  }
}

function collect(p: {
  delta: PrincipalDelta;
  groups: Set<string>;
  accounts: Map<string, SeenIdentity>;
  byAccount: Map<string, Set<string>>;
  connectionId: string;
}): void {
  if (p.delta.type === 'group') {
    p.groups.add(teamTag(p.connectionId, p.delta.group));
    return;
  }
  const tag = teamTag(p.connectionId, p.delta.group);
  p.groups.add(tag);
  const account = p.delta.account;
  const seen: SeenIdentity = {
    externalId: account.externalId,
    ...(account.handle !== undefined ? { handle: account.handle } : {}),
    ...(account.displayName !== undefined ? { displayName: account.displayName } : {}),
    ...(account.email !== undefined ? { email: account.email } : {}),
  };
  p.accounts.set(account.externalId, seen);
  const tags = p.byAccount.get(account.externalId) ?? new Set<string>();
  tags.add(tag);
  p.byAccount.set(account.externalId, tags);
}
