import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, Table } from 'surrealdb';
import type { LiveSubscription } from 'surrealdb';
import { envFlagEnabled } from '../common/env-validation';
import { queryRows } from '../db/surreal.service';
import {
  makeRowPolicyFilter,
  type PredicatePolicyLookup,
} from '../policy/row-filter';

/** One `SHOW CHANGES` batch row: a versionstamp plus its changefeed items. */
interface ChangefeedShowRow {
  versionstamp?: number | string;
  changes?: unknown[];
}

/** One knowledge-fact change delivered to a subscriber. */
export interface LiveFactEvent {
  kind: 'fact';
  /** CREATE / UPDATE / DELETE as reported by the source. */
  action: string;
  factId: string;
  predicate: string;
  object: string;
  entityId: string | null;
  /** 'live' = pushed by LIVE SELECT; 'replay' = recovered from the changefeed. */
  via: 'live' | 'replay';
}

/**
 * The subscriber must resynchronise from a full read — its queue overflowed,
 * or it was offline longer than the changefeed's 30-day retention, so the
 * stream can no longer promise completeness. Saying so is the honest move;
 * silently skipping events is not.
 */
export interface LiveResyncEvent {
  kind: 'resync';
  reason: 'backpressure' | 'retention';
}

export type LiveEvent = LiveFactEvent | LiveResyncEvent;

export interface LiveSubscribeOptions {
  callerScopes: readonly string[];
  /** Delivery sink. Must not throw; a throwing sink is dropped. */
  sink: (event: LiveEvent) => void;
  /** Tenant-aware predicate policy source (registry-backed on request paths). */
  policyLookup?: PredicatePolicyLookup;
}

export interface LiveHandle {
  id: string;
  close(): Promise<void>;
}

interface Subscriber {
  id: string;
  callerScopes: readonly string[];
  sink: (event: LiveEvent) => void;
  policyLookup?: PredicatePolicyLookup | undefined;
  /** Bounded outbox depth; overflow → resync signal, never unbounded memory. */
  queued: number;
}

interface TenantChannel {
  conn: Surreal;
  sub: LiveSubscription;
  unsubscribe: () => void;
  subscribers: Map<string, Subscriber>;
  /** Changefeed cursor — everything at or below this has been accounted for. */
  versionstamp: number;
  /** Fact ids the LIVE path already delivered, so replay doesn't double-send. */
  delivered: Set<string>;
  timer: NodeJS.Timeout | null;
}

const TABLE = 'knowledge_fact';

/**
 * LiveSubscriptionManager — realtime fact subscriptions (flag
 * `LIVE_SUBSCRIPTIONS_ENABLED`, default off). Stage 3 of
 * docs/roadmap/live-queries-2026-07.md: a SINGLE-POD, single-connection-per-
 * tenant prototype that proves the two hard parts (resume without gaps, and
 * the ABAC fence on a push path) before any multi-pod fan-out is designed.
 *
 * WHY A DEDICATED CONNECTION. `SurrealService` is acquire-switch-release: a
 * request takes an idle pooled connection, `use()`s it into its tenant DB,
 * queries, and gives it back. A `LIVE SELECT` has to be HELD for the lifetime
 * of the subscription, so putting one on a pooled connection would either pin a
 * pool slot forever or have the subscription silently retargeted to another
 * tenant's database by the next `use()`. Subscriptions therefore own
 * connections outside both pools.
 *
 * WHY LIVE ALONE IS NOT ENOUGH. A dropped and re-established `LIVE` misses
 * every change in the gap — the driver restarts managed subscriptions but
 * cannot replay what it never received. For a memory product that is data
 * loss. So this runs LIVE for latency and the existing 30-day
 * `CHANGEFEED INCLUDE ORIGINAL` for completeness: a catch-up tick reads
 * `SHOW CHANGES FOR TABLE knowledge_fact SINCE <versionstamp>` and emits
 * anything LIVE did not deliver, deduped by fact id. The changefeed — not the
 * socket — is the source of truth about what happened.
 *
 * WHY THE FENCE IS NOT OPTIONAL. LIVE rows arrive raw: they never pass the
 * per-row `makeRowPolicyFilter` every read surface applies, and the DB-level
 * PERMISSIONS fence is known-partial (system users bypass it — the
 * "phantom-fence" finding). A standing subscription that skipped the gate
 * would be a permanent ABAC bypass, so every event is filtered with the
 * SUBSCRIBER's scopes before delivery.
 */
@Injectable()
export class LiveSubscriptionManager implements OnApplicationShutdown {
  private readonly logger = new Logger(LiveSubscriptionManager.name);
  private readonly channels = new Map<string, TenantChannel>();
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly namespace: string;
  private readonly creds: { username: string; password: string };
  private readonly maxSubscribersPerTenant: number;
  private readonly maxQueuePerSubscriber: number;
  private readonly catchUpMs: number;
  private seq = 0;

  constructor(private readonly config: ConfigService) {
    this.enabled = envFlagEnabled(
      config.get<string>('LIVE_SUBSCRIPTIONS_ENABLED'),
    );
    this.url = config.get<string>('SURREALDB_URL', '');
    this.namespace = config.get<string>('SURREALDB_NAMESPACE', 'brain');
    this.creds = {
      username: config.get<string>('SURREALDB_USERNAME', ''),
      password: config.get<string>('SURREALDB_PASSWORD', ''),
    };
    this.maxSubscribersPerTenant = parseInt(
      config.get<string>('LIVE_MAX_SUBSCRIBERS_PER_TENANT', '20'),
      10,
    );
    this.maxQueuePerSubscriber = parseInt(
      config.get<string>('LIVE_MAX_QUEUE_PER_SUBSCRIBER', '500'),
      10,
    );
    this.catchUpMs = parseInt(
      config.get<string>('LIVE_CATCHUP_INTERVAL_MS', '10000'),
      10,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Attach a subscriber to a tenant's fact stream. The first subscriber for a
   * tenant opens the connection + LIVE query; the last one to leave closes
   * them, so an idle tenant holds no socket.
   */
  async subscribe(
    companyId: string,
    opts: LiveSubscribeOptions,
  ): Promise<LiveHandle> {
    if (!this.enabled) throw new Error('live subscriptions are disabled');
    const channel = await this.channelFor(companyId);
    if (channel.subscribers.size >= this.maxSubscribersPerTenant) {
      throw new Error(
        `live subscription cap reached for tenant (${this.maxSubscribersPerTenant})`,
      );
    }
    const id = `sub_${++this.seq}`;
    channel.subscribers.set(id, {
      id,
      callerScopes: opts.callerScopes,
      sink: opts.sink,
      policyLookup: opts.policyLookup,
      queued: 0,
    });
    return {
      id,
      close: async () => {
        channel.subscribers.delete(id);
        if (channel.subscribers.size === 0) {
          await this.closeChannel(companyId);
        }
      },
    };
  }

  async onApplicationShutdown(): Promise<void> {
    for (const companyId of [...this.channels.keys()]) {
      await this.closeChannel(companyId);
    }
  }

  /** Open (or reuse) the tenant's dedicated connection + LIVE subscription. */
  private async channelFor(companyId: string): Promise<TenantChannel> {
    const existing = this.channels.get(companyId);
    if (existing) return existing;

    const conn = new Surreal();
    await conn.connect(this.url);
    await conn.signin(this.creds);
    await conn.use({ namespace: this.namespace, database: dbNameFor(companyId) });

    // Anchor the changefeed cursor BEFORE the LIVE query starts. Anything
    // already committed is the subscriber's problem to read normally; from
    // here on, every change reaches them via LIVE or via replay.
    const versionstamp = await currentVersionstamp(conn);
    const sub = await conn.live<Record<string, unknown>>(new Table(TABLE));
    const channel: TenantChannel = {
      conn,
      sub,
      unsubscribe: () => undefined,
      subscribers: new Map(),
      versionstamp,
      delivered: new Set(),
      timer: null,
    };
    channel.unsubscribe = sub.subscribe((msg) => {
      const event = toFactEvent(msg, 'live');
      if (!event) return;
      channel.delivered.add(event.factId);
      this.fanOut(channel, event);
    });
    channel.timer = setInterval(() => {
      void this.catchUp(companyId).catch((e) =>
        this.logger.warn(`live catch-up failed: ${(e as Error).message}`),
      );
    }, this.catchUpMs);
    // Never hold the process open for a subscription.
    channel.timer.unref?.();
    this.channels.set(companyId, channel);
    return channel;
  }

  /**
   * The completeness leg. Reads the changefeed from the cursor and emits
   * anything the socket did not deliver — the gap after a reconnect, and any
   * change committed while the LIVE query was being re-established.
   *
   * Exposed (not private) so a test can drive one tick deterministically
   * instead of waiting on the interval.
   */
  async catchUp(companyId: string): Promise<number> {
    const channel = this.channels.get(companyId);
    if (!channel) return 0;
    const changes = await queryRows<ChangefeedShowRow>(
      channel.conn,
      `SHOW CHANGES FOR TABLE ${TABLE} SINCE ${channel.versionstamp} LIMIT 1000`,
    );
    let emitted = 0;
    let highest = channel.versionstamp;
    for (const change of changes) {
      const vs = Number(change.versionstamp ?? 0);
      if (vs <= channel.versionstamp) continue;
      if (vs > highest) highest = vs;
      for (const item of change.changes ?? []) {
        const event = toReplayEvent(item);
        if (!event) continue;
        // Already pushed over the socket — replay must not double-deliver.
        if (channel.delivered.delete(event.factId)) continue;
        this.fanOut(channel, event);
        emitted += 1;
      }
    }
    channel.versionstamp = highest;
    // The dedup set only guards the window between a live push and the next
    // catch-up tick; anything still in it after a tick was never seen by the
    // changefeed and would otherwise leak.
    if (channel.delivered.size > 10_000) channel.delivered.clear();
    return emitted;
  }

  /**
   * Deliver one event to every subscriber that is allowed to see it, applying
   * the SAME per-row scope/ABAC verdict `/v1/search` applies. `policy: null`
   * keeps the scope gate while forcing the ABAC context off: a push has no
   * request context to read one from, and inheriting whatever context happened
   * to be on the async stack would make delivery non-deterministic.
   */
  private fanOut(channel: TenantChannel, event: LiveFactEvent): void {
    for (const s of channel.subscribers.values()) {
      const gate = makeRowPolicyFilter({
        callerScopes: s.callerScopes,
        surface: 'live_subscription',
        policy: null,
        policyLookup: s.policyLookup,
      });
      const allowed = gate.filter({
        predicate: event.predicate,
        id: event.factId,
      });
      gate.finish();
      if (!allowed) continue;
      if (s.queued >= this.maxQueuePerSubscriber) {
        this.safeSend(channel, s, { kind: 'resync', reason: 'backpressure' });
        continue;
      }
      this.safeSend(channel, s, event);
    }
  }

  /** A sink that throws is a broken consumer — drop it rather than the stream. */
  private safeSend(
    channel: TenantChannel,
    s: Subscriber,
    event: LiveEvent,
  ): void {
    try {
      s.queued += 1;
      s.sink(event);
      s.queued -= 1;
    } catch (e) {
      this.logger.warn(
        `live subscriber ${s.id} sink threw, dropping: ${(e as Error).message}`,
      );
      channel.subscribers.delete(s.id);
    }
  }

  private async closeChannel(companyId: string): Promise<void> {
    const channel = this.channels.get(companyId);
    if (!channel) return;
    this.channels.delete(companyId);
    if (channel.timer) clearInterval(channel.timer);
    try {
      channel.unsubscribe();
      await channel.sub.kill();
    } catch {
      // Killing a subscription on an already-dead socket throws; ignored.
    }
    try {
      await channel.conn.close();
    } catch {
      // Same.
    }
  }
}

/** Tenant database name — the double-prefix the rest of the service uses. */
export function dbNameFor(companyId: string): string {
  return `co_${companyId}`;
}

/**
 * Where the changefeed stands right now. `SINCE 0` would replay the whole
 * 30-day retention on the first tick, so a new channel anchors here.
 * Unreadable → 0, which is safe-but-noisy (replays history) rather than
 * silently skipping forward past real changes.
 */
async function currentVersionstamp(conn: Surreal): Promise<number> {
  try {
    const changes = await queryRows<ChangefeedShowRow>(
      conn,
      `SHOW CHANGES FOR TABLE ${TABLE} SINCE 0 LIMIT 100000`,
    );
    return changes.reduce(
      (max, c) => Math.max(max, Number(c.versionstamp ?? 0)),
      0,
    );
  } catch {
    return 0;
  }
}

/** LIVE message → event. Non-fact payloads and malformed rows yield null. */
export function toFactEvent(
  msg: { action?: unknown; recordId?: unknown; value?: unknown },
  via: 'live' | 'replay',
): LiveFactEvent | null {
  const value = (msg?.value ?? {}) as Record<string, unknown>;
  const factId = String(msg?.recordId ?? value.id ?? '');
  if (!factId || typeof value.predicate !== 'string') return null;
  return {
    kind: 'fact',
    action: String(msg?.action ?? 'UPDATE'),
    factId,
    predicate: value.predicate,
    object: typeof value.object === 'string' ? value.object : '',
    entityId: value.entityId ? String(value.entityId) : null,
    via,
  };
}

/**
 * One `SHOW CHANGES` item → event. The changefeed's shape differs from a LIVE
 * message: the row sits under `update` / `delete` rather than `value`, and
 * carries no action of its own.
 */
export function toReplayEvent(item: unknown): LiveFactEvent | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const row = (i.update ?? i.delete) as Record<string, unknown> | undefined;
  if (!row) return null;
  return toFactEvent(
    { action: i.delete ? 'DELETE' : 'UPDATE', recordId: row.id, value: row },
    'replay',
  );
}
