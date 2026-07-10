import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../db/surreal.service';
import { PolicyDecision } from './policy.types';

export interface PolicyDecisionRow {
  keyHash: string;
  kind: 'action' | 'row';
  decision: PolicyDecision;
  mode: 'report_only' | 'enforce';
  action?: string;
  policySet?: string;
  ruleId?: string;
  requestId?: string;
  rowCounts?: { total: number; denied: number };
  sampleFactIds?: string[];
  samplePredicates?: string[];
  sampled?: boolean;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 500;
const MAX_BUFFER = 5_000;
const RETENTION_DAYS = 30;
const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Buffered writer for the policy_decision stream (bulk-INSERT pattern,
 * see changefeed-drain). Decisions are observability, not enforcement:
 * a lost buffer on hard crash costs a few seconds of decision rows,
 * never an access-control outcome. Hence fire-and-forget writes with a
 * bounded buffer (oldest dropped past MAX_BUFFER) and best-effort flush
 * on shutdown.
 *
 * Retention is pruned lazily on flush, at most once per 6 h per tenant
 * — no leader election needed, a concurrent double-DELETE across pods
 * is idempotent.
 */
@Injectable()
export class PolicyDecisionSink implements OnModuleDestroy {
  private readonly logger = new Logger(PolicyDecisionSink.name);
  private readonly buffers = new Map<string, PolicyDecisionRow[]>();
  private readonly lastPruneAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly retentionDays: number;

  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
  ) {
    const days = parseInt(
      config.get<string>('POLICY_DECISION_RETENTION_DAYS', String(RETENTION_DAYS)),
      10,
    );
    this.retentionDays = Number.isFinite(days) && days > 0 ? days : RETENTION_DAYS;
  }

  record(companyId: string, row: PolicyDecisionRow): void {
    let buf = this.buffers.get(companyId);
    if (!buf) {
      buf = [];
      this.buffers.set(companyId, buf);
    }
    buf.push(row);
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    if (buf.length >= FLUSH_THRESHOLD) {
      void this.flushAll();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flushAll();
      }, FLUSH_INTERVAL_MS);
      // Never keep the process alive just to flush decision telemetry.
      this.timer.unref?.();
    }
  }

  async flushAll(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const entries = [...this.buffers.entries()].filter(([, b]) => b.length > 0);
      for (const [companyId, buf] of entries) {
        const rows = buf.splice(0, buf.length);
        try {
          await this.surreal.withCompany(companyId, async (db) => {
            await db.query(`INSERT INTO policy_decision $rows`, { rows });
            const last = this.lastPruneAt.get(companyId) ?? 0;
            if (Date.now() - last > PRUNE_MIN_INTERVAL_MS) {
              this.lastPruneAt.set(companyId, Date.now());
              await db.query(
                `DELETE policy_decision WHERE ts < time::now() - ${this.retentionDays}d`,
              );
            }
          });
        } catch (e) {
          this.logger.warn(
            `policy_decision flush failed for ${companyId} (${rows.length} rows dropped): ${(e as Error).message}`,
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flushAll();
  }
}
