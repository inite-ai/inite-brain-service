import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StringRecordId } from 'surrealdb';
import { ApiKeyService } from '../auth/api-key.service';
import { DistributedLeaseGuard, noteUnguarded } from '../common/distributed-lease.guard';
import { SurrealService, isUniqueViolation, queryFirst, queryRows } from '../db/surreal.service';

/** How long a key answers for (draft-ietf-httpapi-idempotency-key-header: the server picks). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const LOCK_KEY = 'idempotency_sweep';
const LEASE_TTL_SECONDS = 30 * 60;

export interface IdempotencyRequest {
  scopeKey: string;
  key: string;
  method: string;
  route: string;
  fingerprint: string;
  userId?: string | undefined;
}

/** What the first request under a key decides for this one. */
export type IdempotencyDecision =
  | { kind: 'proceed'; id: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' };

interface KeyRow {
  id: unknown;
  fingerprint: string;
  state: 'pending' | 'done';
  status?: number;
  body?: string;
  expiresAt: unknown;
}

/**
 * The stored answers behind the Idempotency-Key header (0179). The first
 * request under (credential, key) claims the row as `pending`; its
 * response completes it, or a 5xx releases it so the client can retry.
 * The unique index decides a race between two first requests: the loser
 * sees the winner's row.
 */
@Injectable()
export class IdempotencyStoreService {
  private readonly logger = new Logger(IdempotencyStoreService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly apiKeys?: ApiKeyService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  async begin(companyId: string, r: IdempotencyRequest): Promise<IdempotencyDecision> {
    return this.surreal.withCompany(companyId, async (db) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await queryFirst<KeyRow>(
          db,
          `SELECT id, fingerprint, state, status, body, expiresAt FROM idempotency_key
             WHERE scopeKey = $scopeKey AND key = $key LIMIT 1`,
          { scopeKey: r.scopeKey, key: r.key },
        );
        if (row && new Date(row.expiresAt as string).getTime() > Date.now()) {
          return decide(row, r.fingerprint);
        }
        if (row) await db.query(`DELETE $id`, { id: new StringRecordId(String(row.id)) });
        try {
          const created = await queryFirst<{ id: unknown }>(
            db,
            `CREATE idempotency_key CONTENT $row RETURN id`,
            {
              row: {
                scopeKey: r.scopeKey,
                key: r.key,
                method: r.method,
                route: r.route,
                fingerprint: r.fingerprint,
                state: 'pending',
                ...(r.userId ? { userId: r.userId } : {}),
                expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
              },
            },
          );
          return { kind: 'proceed', id: String(created?.id) };
        } catch (e) {
          // Another first request won the index; read its row next round.
          if (!isUniqueViolation(e)) throw e;
        }
      }
      return { kind: 'in_flight' };
    });
  }

  /** The response the key answers with from now on. */
  async complete(
    companyId: string,
    id: string,
    answer: { status: number; body: unknown },
  ): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE $id SET state = 'done', status = $status, body = $body`, {
        id: new StringRecordId(id),
        status: answer.status,
        body: JSON.stringify(answer.body ?? null),
      }),
    );
  }

  /** A 5xx (or a dropped connection): the key is free again, so a retry runs. */
  async release(companyId: string, id: string): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`DELETE $id`, { id: new StringRecordId(id) }),
    );
  }

  @Cron('50 4 * * *', { timeZone: 'UTC' })
  async sweepNightly(): Promise<void> {
    try {
      if (!this.guard) noteUnguarded(this.logger, LOCK_KEY);
      const run = this.guard
        ? await this.guard.run(LOCK_KEY, () => this.sweep(), LEASE_TTL_SECONDS)
        : await this.sweep();
      if (run === null) this.logger.log('idempotency sweep skipped — another run holds the lease');
    } catch (e) {
      this.logger.warn(`idempotency sweep failed: ${(e as Error).message}`);
    }
  }

  /** Deletes expired keys in every tenant; returns how many. */
  async sweep(tenants?: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const companyId of tenants ?? this.apiKeys?.fanOutRoster() ?? []) {
      try {
        deleted += await this.surreal.withCompany(companyId, async (db) => {
          let n = 0;
          for (;;) {
            const ids = await queryRows<unknown>(
              db,
              `SELECT VALUE id FROM idempotency_key WHERE expiresAt < time::now() LIMIT 1000`,
            );
            if (ids.length === 0) return n;
            await db.query(`DELETE $ids`, { ids });
            n += ids.length;
          }
        });
      } catch (e) {
        this.logger.warn(`idempotency sweep for ${companyId} failed: ${(e as Error).message}`);
      }
    }
    if (deleted > 0) this.logger.log(`idempotency sweep: ${deleted} expired key(s) deleted`);
    return deleted;
  }
}

function decide(row: KeyRow, fingerprint: string): IdempotencyDecision {
  if (row.fingerprint !== fingerprint) return { kind: 'mismatch' };
  if (row.state === 'pending') return { kind: 'in_flight' };
  return {
    kind: 'replay',
    status: row.status ?? 200,
    body: row.body === undefined ? null : (JSON.parse(row.body) as unknown),
  };
}
