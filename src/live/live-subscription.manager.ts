import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveSubscriptionError, Surreal, Table } from 'surrealdb';
import type { LiveSubscription } from 'surrealdb';
import { envFlagEnabled } from '../common/env-validation';
import { queryRows, withTimeout } from '../db/surreal.service';
import { SurrealSessionKeeper } from '../db/session-keeper';
import { changefeedRow } from '../db/changefeed-row';
import { makeRowPolicyFilter, type PredicatePolicyLookup } from '../policy/row-filter';

/**
 * One `SHOW CHANGES` batch row: a versionstamp plus its changefeed items.
 * On SurrealDB 3.x the versionstamp is a u64 (~1.17e17, past
 * Number.MAX_SAFE_INTEGER) and the SDK hands it over as a bigint; a unit
 * stub may still emit a plain number. Both go through BigInt().
 */
interface ChangefeedShowRow {
  versionstamp?: number | bigint | string;
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
  /** Detaches the LIVE handler and the connection-event listeners. */
  unsubscribe: () => void;
  subscribers: Map<string, Subscriber>;
  /**
   * Changefeed cursor — everything at or below this has been accounted for.
   * bigint end to end: folded through Number() two same-millisecond commits
   * (16 apart at this magnitude) round to one value, and `vs <= cursor` then
   * skips or re-delivers them.
   */
  versionstamp: bigint;
  /** Fact ids the LIVE path already delivered, so replay doesn't double-send. */
  delivered: Set<string>;
  timer: NodeJS.Timeout | null;
  /** A catch-up tick is running; the interval must not stack another. */
  catchingUp: boolean;
  /**
   * The driver failed to restart the LIVE query after a reconnect
   * (LiveSubscriptionError on the connection) while `sub.isAlive` still says
   * true — measured on 3.2.4 after an outage longer than its reconnect
   * budget. The next tick rebuilds.
   */
  liveBroken: boolean;
}

const TABLE = 'knowledge_fact';
/** Bounds on the statements a catch-up tick issues on a standing socket. */
const CONNECT_TIMEOUT_MS = 5_000;
const SIGNIN_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 3_000;
const CATCHUP_QUERY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;

type LiveCredentials =
  | { username: string; password: string }
  | { username: string; password: string; namespace: string };

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
 * WHY THE TICK ALSO CHECKS THE CONNECTION. The pools survive a database
 * restart because every acquire runs `ensureSession` (a bounded `RETURN 1`
 * probe, then a rebuild). A subscription connection is handed out to nobody,
 * so the tick is where the same discipline lives: a half-open socket
 * (surrealdb-js gh#618 — status stays "connected"), a driver whose reconnect
 * attempts ran out, or a session the driver brought back anonymous all fail
 * the probe, and the channel is rebuilt on a fresh connection — new signin,
 * new LIVE query — while the cursor it kept replays whatever the outage hid.
 * Without that, every tick fails the same way forever and the subscribers
 * starve silently.
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
  private readonly creds: LiveCredentials;
  private readonly maxSubscribersPerTenant: number;
  private readonly maxQueuePerSubscriber: number;
  private readonly catchUpMs: number;
  /**
   * Subscription connections live OUTSIDE both pools, so they follow the
   * same expiry discipline on their own: surrealdb-js invalidates a
   * `signin()`-established session at `exp − 60s`, and a standing
   * subscription is the longest-lived connection in the process. The
   * catch-up tick re-signs before that (see db/session-keeper.ts).
   */
  private readonly sessions = new SurrealSessionKeeper();
  private seq = 0;

  constructor(private readonly config: ConfigService) {
    this.enabled = envFlagEnabled(config.get<string>('LIVE_SUBSCRIPTIONS_ENABLED'));
    this.url = config.get<string>('SURREALDB_URL', '');
    this.namespace = config.get<string>('SURREALDB_NAMESPACE', 'brain');
    // Same identity as the caller-facing read pool: `brain_caller` when the
    // scoped pool is configured, root otherwise. A push path is a read path;
    // it must not hold a wider identity than `/v1/search` does.
    const scopedUser = config.get<string>('SURREALDB_SCOPED_USER');
    const scopedPass = config.get<string>('SURREALDB_SCOPED_PASS');
    this.creds =
      scopedUser && scopedPass
        ? { username: scopedUser, password: scopedPass, namespace: this.namespace }
        : {
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
    this.catchUpMs = parseInt(config.get<string>('LIVE_CATCHUP_INTERVAL_MS', '10000'), 10);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Attach a subscriber to a tenant's fact stream. The first subscriber for a
   * tenant opens the connection + LIVE query; the last one to leave closes
   * them, so an idle tenant holds no socket.
   */
  async subscribe(companyId: string, opts: LiveSubscribeOptions): Promise<LiveHandle> {
    if (!this.enabled) throw new Error('live subscriptions are disabled');
    const channel = await this.channelFor(companyId);
    if (channel.subscribers.size >= this.maxSubscribersPerTenant) {
      throw new Error(`live subscription cap reached for tenant (${this.maxSubscribersPerTenant})`);
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

    const conn = await this.openConnection(companyId);
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
      catchingUp: false,
      liveBroken: false,
    };
    channel.unsubscribe = this.attach(companyId, channel);
    channel.timer = setInterval(() => this.tick(companyId), this.catchUpMs);
    // Never hold the process open for a subscription.
    channel.timer.unref?.();
    this.channels.set(companyId, channel);
    return channel;
  }

  /** A fresh, signed-in connection switched to the tenant's database. */
  private async openConnection(companyId: string): Promise<Surreal> {
    const conn = new Surreal();
    try {
      // Bounded: a published port can accept TCP before the server takes
      // websockets (docker-proxy), where an unbounded connect() hangs.
      await withTimeout(conn.connect(this.url), CONNECT_TIMEOUT_MS, 'live connect');
      await this.signin(conn);
      await conn.use({ namespace: this.namespace, database: dbNameFor(companyId) });
      return conn;
    } catch (e) {
      await withTimeout(conn.close(), CLOSE_TIMEOUT_MS, 'live close').catch(() => undefined);
      throw e;
    }
  }

  /**
   * Wire the channel's current connection: LIVE messages fan out, and the
   * driver's own reconnect (or its giving up) runs a tick at once instead of
   * up to an interval later — the tick decides what state the session and
   * the standing LIVE query came back in.
   */
  private attach(companyId: string, channel: TenantChannel): () => void {
    const { conn, sub } = channel;
    const offLive = sub.subscribe((msg) => {
      const event = toFactEvent(msg, 'live');
      if (!event) return;
      channel.delivered.add(event.factId);
      this.fanOut(channel, event);
    });
    const offConnected = conn.subscribe('connected', () => this.tick(companyId));
    const offDisconnected = conn.subscribe('disconnected', () => this.tick(companyId));
    const offError = conn.subscribe('error', (err) => {
      if (!(err instanceof LiveSubscriptionError)) return;
      channel.liveBroken = true;
      this.tick(companyId);
    });
    return () => {
      offLive();
      offConnected();
      offDisconnected();
      offError();
    };
  }

  private tick(companyId: string): void {
    void this.catchUp(companyId).catch((e) =>
      this.logger.warn(`live catch-up failed for ${companyId}: ${(e as Error).message}`),
    );
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
    // A tick that outlives the interval (half-open socket, slow server)
    // must not stack the next one on top of it.
    if (channel.catchingUp) return 0;
    channel.catchingUp = true;
    try {
      await this.ensureLive(companyId, channel);
      const changes = await withTimeout(
        queryRows<ChangefeedShowRow>(
          channel.conn,
          `SHOW CHANGES FOR TABLE ${TABLE} SINCE ${channel.versionstamp} LIMIT 1000`,
        ),
        CATCHUP_QUERY_TIMEOUT_MS,
        'live catch-up',
      );
      return this.replay(channel, changes);
    } finally {
      channel.catchingUp = false;
    }
  }

  /**
   * The connection and the standing LIVE query must both be usable before
   * the tick reads the changefeed. Same discipline as SurrealService's
   * `ensureSession`: a session outside the re-auth margin gets a bounded
   * `RETURN 1` probe, one inside it (or one the driver already dropped) is
   * re-signed; if either fails, or the driver reports the LIVE query dead,
   * the channel is rebuilt on a fresh connection and the kept cursor
   * replays the gap (test/live-db-restart.e2e-spec.ts).
   */
  private async ensureLive(companyId: string, channel: TenantChannel): Promise<void> {
    const { conn, sub } = channel;
    try {
      if (conn.isConnected && conn.accessToken && !this.sessions.needsSignin(conn)) {
        await withTimeout(conn.query('RETURN 1'), PROBE_TIMEOUT_MS, 'live probe');
      } else {
        await this.signin(conn);
      }
      if (channel.liveBroken) throw new Error('LIVE query failed to restart');
      if (sub.isAlive) return;
      throw new Error('LIVE query is no longer alive');
    } catch (e) {
      this.logger.warn(
        `live channel check failed for ${companyId} ` +
          `(${(e as Error).message?.slice(0, 120)}) — rebuilding`,
      );
    }
    await this.rebuild(companyId, channel);
  }

  /**
   * Replace the channel's connection and LIVE query, keeping its subscribers
   * and its cursor. The replacement is built FIRST; if it cannot be, the old
   * one stays in place and the tick fails loudly for the interval to retry.
   */
  private async rebuild(companyId: string, channel: TenantChannel): Promise<void> {
    const conn = await this.openConnection(companyId);
    let sub: LiveSubscription;
    try {
      sub = await conn.live<Record<string, unknown>>(new Table(TABLE));
    } catch (e) {
      await withTimeout(conn.close(), CLOSE_TIMEOUT_MS, 'live close').catch(() => undefined);
      throw e;
    }
    if (this.channels.get(companyId) !== channel) {
      // The last subscriber left while the replacement was being built and
      // closeChannel already tore the old sockets down; this one must not
      // outlive it.
      await withTimeout(conn.close(), CLOSE_TIMEOUT_MS, 'live close').catch(() => undefined);
      throw new Error('channel closed during rebuild');
    }
    const old = { conn: channel.conn, unsubscribe: channel.unsubscribe };
    channel.conn = conn;
    channel.sub = sub;
    channel.liveBroken = false;
    channel.unsubscribe = this.attach(companyId, channel);
    this.sessions.forget(old.conn);
    old.unsubscribe();
    // Closing the socket drops its server-side LIVE query with it; a KILL on
    // a connection that may be half-open would only hang.
    await withTimeout(old.conn.close(), CLOSE_TIMEOUT_MS, 'live close').catch(() => undefined);
    this.logger.log(
      `live channel for ${companyId} rebuilt; replaying the changefeed from ${channel.versionstamp}`,
    );
  }

  private replay(channel: TenantChannel, changes: ChangefeedShowRow[]): number {
    let emitted = 0;
    let highest = channel.versionstamp;
    for (const change of changes) {
      const vs = BigInt(change.versionstamp ?? 0);
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
  private safeSend(channel: TenantChannel, s: Subscriber, event: LiveEvent): void {
    try {
      s.queued += 1;
      s.sink(event);
      s.queued -= 1;
    } catch (e) {
      this.logger.warn(`live subscriber ${s.id} sink threw, dropping: ${(e as Error).message}`);
      channel.subscribers.delete(s.id);
    }
  }

  /** Sign the connection in and record the access token's expiry. */
  private async signin(conn: Surreal): Promise<void> {
    const tokens = await withTimeout(conn.signin(this.creds), SIGNIN_TIMEOUT_MS, 'live signin');
    this.sessions.record(conn, tokens?.access);
  }

  private async closeChannel(companyId: string): Promise<void> {
    const channel = this.channels.get(companyId);
    if (!channel) return;
    this.channels.delete(companyId);
    this.sessions.forget(channel.conn);
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
async function currentVersionstamp(conn: Surreal): Promise<bigint> {
  try {
    const changes = await queryRows<ChangefeedShowRow>(
      conn,
      `SHOW CHANGES FOR TABLE ${TABLE} SINCE 0 LIMIT 100000`,
    );
    return changes.reduce((max, c) => {
      const vs = BigInt(c.versionstamp ?? 0);
      return vs > max ? vs : max;
    }, 0n);
  } catch {
    return 0n;
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
  // Post-image via the shared helper: on a CREATE the row is under `update`,
  // but on an UPDATE `update` is a reverse PATCH ARRAY and the row is under
  // `current` — reading `item.update.id` there is undefined, which silently
  // dropped every fact UPDATE from replay (same shape trap as the audit drain,
  // R4 #3). A delete carries only its id, so keep the prior id-only path.
  const row = changefeedRow(item) ?? (i.delete as Record<string, unknown> | undefined);
  if (!row) return null;
  return toFactEvent(
    { action: i.delete ? 'DELETE' : 'UPDATE', recordId: row.id, value: row },
    'replay',
  );
}
