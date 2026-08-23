import { createHash, randomUUID } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import { runTransaction } from '../db/surreal.service';
import type { LeaderLeaseService } from '../jobs/leader-lease.service';

/**
 * Derive atomicity (external audit 2026-08-19 P1).
 *
 * The batch deriver used to write knowledge_fact / conversation_digest
 * rows DIRECTLY under the target derivedVersion while the run was in
 * flight: a crash mid-run left a half-written world readable by anyone
 * pinned to that version, and two concurrent derives for the same
 * (tenant, version) interleaved rows. This module gives
 * WindowDeriverService the three primitives that close the hole:
 *
 *   1. Staging namespace — every row a run writes is stamped
 *      `<version>.staging` instead of the final version. Read paths pin
 *      EXACT versions (buildBaseWhere: `derivedVersion = $v` /
 *      `IS NONE`), and the admin API's version regex rejects dots, so
 *      the staging namespace is structurally invisible to readers.
 *
 *   2. Per-(tenant, version) lease — a second concurrent derive fails
 *      fast instead of interleaving rows inside the same staging
 *      namespace. Cross-pod exclusion rides the existing leader_lease
 *      CAS primitive (the one the LeaseManagerService cron already
 *      uses); an in-process set covers same-pod overlap, which the
 *      leader lease alone would ADMIT (its identity is per-process,
 *      not per-run — re-acquire by the same leaderId succeeds).
 *
 *   3. Atomic flip — after a CLEAN run, promoteStaging() replaces the
 *      final world with the staged one: DELETE the final version's
 *      rows then UPDATE staging rows SET derivedVersion = final, for
 *      BOTH tables (knowledge_fact and conversation_digest) inside ONE
 *      SurrealDB BEGIN/COMMIT transaction (runTransaction, audit
 *      2026-08-21) — readers see either the old world or the new one,
 *      never empty, never mixed, and never new facts narrated by old
 *      digests. A failed or degraded run never calls the flip: the
 *      final world stays byte-identical and the staging rows are swept
 *      (best-effort; the prefix orphan GC at the start of the next run
 *      for the same version catches what a crash stranded).
 */

export const STAGING_SUFFIX = '.staging';

export interface DeriveNamespace {
  /** The version readers pin — untouched until the flip. */
  final: string;
  /** `<final>.staging.<runToken>` — the only namespace THIS run writes
   *  into. Per-run unique (audit 2026-08-21 P1 round 2): even if the
   *  lease fails open — heartbeat errors past the TTL, a competing pod
   *  acquiring — two runs can never interleave rows in one staging
   *  namespace; each flip promotes an internally consistent world. */
  staging: string;
}

export function stagingNamespace(version: string, runToken?: string): DeriveNamespace {
  const suffix = runToken ? `${STAGING_SUFFIX}.${runToken}` : STAGING_SUFFIX;
  return { final: version, staging: `${version}${suffix}` };
}

/** Short per-run staging token — see DeriveNamespace.staging. */
export function newRunToken(): string {
  return randomUUID().slice(0, 8);
}

/** Narrow query-only view of the scoped connection (same shape the
 *  deriver already passes around). */
export interface DeriveDb {
  query<T>(sql: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Lease TTL vs run duration: a full-tenant derive is minutes-to-hours
 * of LLM calls, longer than any static TTL we would want a crashed
 * holder to block retries for. So the TTL is modest and a heartbeat
 * re-acquires (leader_lease UPSERT by the same holder renews) every
 * third of it; on a crash the lease expires within LEASE_TTL_SECONDS
 * and the next run proceeds.
 */
const LEASE_TTL_SECONDS = 600;
const LEASE_HEARTBEAT_MS = 200_000;

/** Same-pod re-entrancy guard — see the module header for why the
 *  leader lease alone cannot provide this. */
const inFlight = new Set<string>();

/**
 * leader_lease record ids are string-composed (`'leader_lease:' + $name`),
 * so the name must stay in the unescaped id charset `[a-z0-9_]`.
 * companyId / version are sanitized into a readable slug and the raw
 * pair is hashed so two tenants that sanitize identically cannot
 * collide into one lease.
 */
export function deriveLeaseName(companyId: string, version: string): string {
  const hash = createHash('sha1').update(`${companyId}\u0000${version}`).digest('hex').slice(0, 8);
  const slug = `${companyId}_${version}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 40);
  return `derive_${slug}_${hash}`;
}

export interface DeriveLease {
  name: string;
  /** True once a heartbeat renewal failed for ANY reason — a
   *  definitive loss (`tryAcquire` → false: a competing pod holds it)
   *  or an error (fail-closed, audit 2026-08-21 round 2: an erroring
   *  heartbeat past the TTL is indistinguishable from a lost lease).
   *  Promotion MUST check this fence before flipping staging → final. */
  isLost(): boolean;
  /** Fresh SYNCHRONOUS ownership proof, for the moment before the
   *  flip: re-acquires the lease right now (a held lease renews; a
   *  stale pod that slept past the TTL while another pod took over
   *  gets false). Any uncertainty → false and the isLost fence is set.
   *  Closes the residual stale-isLost window the async heartbeat
   *  cannot (audit round 4 hardening). */
  renew(): Promise<boolean>;
  /** Idempotent; call in finally. */
  release(): Promise<void>;
}

type LeaseLogger = { warn(message: string): void };

/**
 * Take the per-(tenant, version) derive lease or throw the fail-fast
 * conflict error. `lease` is optional (unit tests construct the service
 * without JobsModule); without it only the in-process guard applies.
 */
export async function acquireDeriveLease(args: {
  companyId: string;
  version: string;
  lease?: LeaderLeaseService | undefined;
  logger: LeaseLogger;
}): Promise<DeriveLease> {
  const { companyId, version, lease, logger } = args;
  const key = `${companyId}\u0000${version}`;
  const name = deriveLeaseName(companyId, version);
  const conflict = () =>
    new Error(
      `derive already in flight for tenant '${companyId}' version ` +
        `'${version}' — a concurrent derive for the same (tenant, version) ` +
        `would interleave rows in its staging namespace; retry after the ` +
        `running derive finishes`,
    );
  if (inFlight.has(key)) throw conflict();
  inFlight.add(key);
  let heartbeat: NodeJS.Timeout | undefined;
  let lost = false;
  try {
    if (lease) {
      const got = await lease.tryAcquire(name, LEASE_TTL_SECONDS);
      if (!got) throw conflict();
      heartbeat = setInterval(() => {
        void lease.tryAcquire(name, LEASE_TTL_SECONDS).then(
          (ok) => {
            if (!ok) {
              // Cannot safely abort a run mid-LLM-call; mark the fence —
              // promotion checks isLost() and refuses to flip (a
              // competing pod may be building the same version).
              lost = true;
              logger.warn(
                `derive lease '${name}' lost mid-run — a concurrent ` +
                  `derive may start on another pod; promotion is fenced`,
              );
            }
          },
          (e: unknown) => {
            // Fail-closed (audit 2026-08-21 P1 round 2): ANY renewal
            // uncertainty sets the fence — an erroring heartbeat past
            // the TTL is indistinguishable from a lost lease. Per-run
            // staging namespaces keep the data safe either way; the
            // fence only refuses a flip we can no longer claim to own.
            lost = true;
            logger.warn(
              `derive lease heartbeat failed — promotion fenced: ` + `${(e as Error).message}`,
            );
          },
        );
      }, LEASE_HEARTBEAT_MS);
      heartbeat.unref?.();
    }
  } catch (e) {
    inFlight.delete(key);
    throw e;
  }
  let released = false;
  return {
    name,
    isLost: () => lost,
    renew: async () => {
      if (lost || released) return false;
      if (!lease) return true; // in-process-only guard: nothing to renew
      try {
        const ok = await lease.tryAcquire(name, LEASE_TTL_SECONDS);
        if (!ok) lost = true;
        return ok;
      } catch (e) {
        lost = true;
        logger.warn(`derive lease renew failed — promotion fenced: ` + `${(e as Error).message}`);
        return false;
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      inFlight.delete(key);
      try {
        await lease?.release(name);
      } catch (e) {
        // leader_lease TTL expiry is the backstop.
        logger.warn(`derive lease release failed: ${(e as Error).message}`);
      }
    },
  };
}

/** The two tables a derive run writes versioned rows into. */
const STAGED_TABLES = ['knowledge_fact', 'conversation_digest'] as const;

/**
 * Delete every row of the staging namespace — the GC for failed /
 * degraded runs and for orphans a crashed run stranded (called at the
 * start of a new run for the same version, under the lease). The
 * existence probe first keeps the common no-orphans path free of
 * destructive statements.
 */
export async function sweepStagingRows(db: DeriveDb, staging: string): Promise<void> {
  for (const table of STAGED_TABLES) {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM ${table} WHERE derivedVersion = $version LIMIT 1`,
      { version: staging },
    );
    if (!rows || rows.length === 0) continue;
    await db.query(`DELETE ${table} WHERE derivedVersion = $version`, {
      version: staging,
    });
  }
}

/**
 * Reap EVERY staging namespace of a version — `<version>.staging` and
 * all per-run `<version>.staging.<token>` orphans a crashed run
 * stranded (the run-start GC, under the lease; per-run tokens mean the
 * exact orphan names are unknowable in advance).
 */
export async function sweepStagingOrphans(db: DeriveDb, version: string): Promise<void> {
  const prefix = `${version}${STAGING_SUFFIX}`;
  for (const table of STAGED_TABLES) {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM ${table}
        WHERE string::starts_with(derivedVersion ?? '', $prefix) LIMIT 1`,
      { prefix },
    );
    if (!rows || rows.length === 0) continue;
    await db.query(
      `DELETE ${table}
        WHERE string::starts_with(derivedVersion ?? '', $prefix)`,
      { prefix },
    );
  }
}

/**
 * Promote staging → final. Full-run shape replaces the whole final
 * version; the targeted shape (opts.conversationId) replaces only that
 * conversation's slice and first revives final-world rows of OTHER
 * conversations that the doomed slice had superseded (the 0014
 * sentinel shape — same statement deriveConversation used to run
 * in-place; under staging the cross-conversation supersede can only be
 * repaired here, against the final world, at flip time).
 *
 * Each table's DELETE + UPDATE runs inside one BEGIN/COMMIT — see the
 * module header for the atomicity contract and the bounded
 * facts-before-digests window.
 */
export async function promoteStaging(
  db: DeriveDb,
  ns: DeriveNamespace,
  opts: { conversationId?: string | undefined } = {},
): Promise<void> {
  const conv = opts.conversationId;
  // Audit 2026-08-21: facts and digests flip in ONE transaction — the
  // old two-transaction shape could commit the fact-world and then fail
  // the digest flip, leaving a new fact-world narrated by old digests.
  await runTransaction(db as unknown as Surreal, (tx) => {
    tx.bind('final', ns.final).bind('staging', ns.staging);
    if (conv) {
      tx.bind('conv', conv)
        .add(
          `UPDATE knowledge_fact SET
              status = 'active',
              supersededBy = NONE,
              validUntil = priorValidUntil,
              priorValidUntil = NONE,
              retractionReason = NONE,
              retractedBy = NONE
            WHERE derivedVersion = $final
              AND status = 'superseded'
              AND source.conversationId != $conv
              AND supersededBy IN (
                SELECT VALUE id FROM knowledge_fact
                 WHERE derivedVersion = $final
                   AND source.conversationId = $conv)`,
        )
        .add(
          `DELETE knowledge_fact
            WHERE derivedVersion = $final AND source.conversationId = $conv`,
        )
        .add(
          `UPDATE knowledge_fact SET derivedVersion = $final
            WHERE derivedVersion = $staging AND source.conversationId = $conv`,
        )
        .add(
          `DELETE conversation_digest
            WHERE derivedVersion = $final AND conversationId = $conv`,
        )
        .add(
          `UPDATE conversation_digest SET derivedVersion = $final
            WHERE derivedVersion = $staging AND conversationId = $conv`,
        )
        .add(`RETURN true`);
    } else {
      tx.add(`DELETE knowledge_fact WHERE derivedVersion = $final`)
        .add(
          `UPDATE knowledge_fact SET derivedVersion = $final
            WHERE derivedVersion = $staging`,
        )
        .add(`DELETE conversation_digest WHERE derivedVersion = $final`)
        .add(
          `UPDATE conversation_digest SET derivedVersion = $final
            WHERE derivedVersion = $staging`,
        )
        .add(`RETURN true`);
    }
  });
}
