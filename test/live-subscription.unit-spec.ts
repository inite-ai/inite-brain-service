import {
  LiveSubscriptionManager,
  toFactEvent,
  toReplayEvent,
  dbNameFor,
  type LiveEvent,
} from '../src/live/live-subscription.manager';

/**
 * LIVE subscriptions (LIVE_SUBSCRIPTIONS_ENABLED) — the two things the design
 * doc says must be proven before any multi-pod fan-out is worth designing:
 *
 *   1. RESUME WITHOUT GAPS. A dropped LIVE misses every change in the gap and
 *      the driver cannot replay what it never received, so the 30-day
 *      changefeed is the source of truth about what happened. Replay must
 *      recover the gap AND must not double-deliver what the socket already
 *      pushed.
 *   2. THE FENCE. LIVE rows arrive raw, bypassing the per-row policy gate
 *      every read surface applies, and the DB PERMISSIONS fence is
 *      known-partial. A subscription must never become an ABAC bypass.
 */
describe('LiveSubscriptionManager', () => {
  /** Fake tenant channel wired straight into the manager's internals. */
  function makeManager(env: Record<string, string> = {}) {
    const config = {
      get: (k: string, d?: string) => env[k] ?? d,
    } as never;
    return new LiveSubscriptionManager(config);
  }

  /**
   * Installs a channel without touching the network. `changes` is what the
   * changefeed will report on the next catch-up tick.
   */
  function installChannel(
    mgr: LiveSubscriptionManager,
    opts: { changes?: any[]; versionstamp?: bigint } = {},
  ) {
    const received: Array<{ sub: string; event: LiveEvent }> = [];
    const signins: number[] = [];
    const queries: string[] = [];
    const channel = {
      conn: {
        query: async (sql: string) => {
          queries.push(sql);
          // `RETURN 1` is the tick's liveness probe, not a changefeed read.
          return sql.startsWith('RETURN') ? [1] : [opts.changes ?? []];
        },
        // A subscription connection outlives its access token, so the
        // catch-up tick renews it. Hand back a token that is nowhere near
        // expiring, so a second tick must NOT re-sign.
        signin: async () => {
          signins.push(Date.now());
          return { access: farFutureJwt() };
        },
        // A standing, authenticated socket the tick can probe instead of
        // rebuilding (the real Surreal getters).
        isConnected: true,
        accessToken: farFutureJwt(),
        subscribe: () => () => {},
        close: async () => {},
      },
      sub: { kill: async () => {}, isAlive: true },
      unsubscribe: () => {},
      subscribers: new Map(),
      versionstamp: opts.versionstamp ?? 10n,
      delivered: new Set<string>(),
      timer: null,
      liveBroken: false,
    };
    (mgr as any).channels.set('co_x', channel);
    const addSubscriber = (id: string, scopes: string[], lookup?: any) => {
      channel.subscribers.set(id, {
        id,
        callerScopes: scopes,
        sink: (event: LiveEvent) => received.push({ sub: id, event }),
        policyLookup: lookup,
        queued: 0,
      });
    };
    return { channel, received, addSubscriber, signins, queries };
  }

  /** A syntactically real access token that expires in a year. */
  function farFutureJwt(): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS512' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 31_536_000 })}.s`;
  }

  const change = (versionstamp: number | bigint, id: string, predicate: string) => ({
    versionstamp,
    changes: [{ update: { id, predicate, object: 'v', entityId: 'knowledge_entity:e1' } }],
  });

  describe('message shaping', () => {
    it('turns a LIVE message into a fact event', () => {
      const e = toFactEvent(
        {
          action: 'CREATE',
          recordId: 'knowledge_fact:f1',
          value: { predicate: 'lives_in', object: 'Dublin', entityId: 'knowledge_entity:e1' },
        },
        'live',
      );
      expect(e).toEqual({
        kind: 'fact',
        action: 'CREATE',
        factId: 'knowledge_fact:f1',
        predicate: 'lives_in',
        object: 'Dublin',
        entityId: 'knowledge_entity:e1',
        via: 'live',
      });
    });

    it('rejects a payload with no predicate rather than emitting a half-event', () => {
      expect(toFactEvent({ recordId: 'knowledge_fact:f1', value: {} }, 'live')).toBeNull();
    });

    it('reads the changefeed shape, where the row sits under update/delete', () => {
      expect(
        toReplayEvent({ update: { id: 'knowledge_fact:f1', predicate: 'p', object: 'o' } })?.via,
      ).toBe('replay');
      expect(toReplayEvent({ delete: { id: 'knowledge_fact:f1', predicate: 'p' } })?.action).toBe(
        'DELETE',
      );
      expect(toReplayEvent({ define_table: {} })).toBeNull();
      expect(toReplayEvent(null)).toBeNull();
    });

    it('reads an UPDATE post-image from `current`, not the reverse patch array', () => {
      // INCLUDE ORIGINAL puts the row under `current` and a reverse PATCH
      // ARRAY under `update`. Reading `item.update.id` there is undefined, so
      // every fact UPDATE was silently dropped from replay (R4 #3). The shared
      // changefeedRow helper reads `current`.
      const ev = toReplayEvent({
        current: { id: 'knowledge_fact:f1', predicate: 'likes', object: 'o' },
        update: [{ op: 'change', path: '/object', value: 'x' }],
      });
      expect(ev).not.toBeNull();
      expect(ev?.factId).toBe('knowledge_fact:f1');
      expect(ev?.predicate).toBe('likes');
      expect(ev?.via).toBe('replay');
    });

    it('uses the double-prefixed tenant database name', () => {
      expect(dbNameFor('co_acme')).toBe('co_co_acme');
    });
  });

  describe('resume bridge', () => {
    it('replays changes the socket never delivered', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [
          change(11, 'knowledge_fact:a', 'lives_in'),
          change(12, 'knowledge_fact:b', 'reads'),
        ],
      });
      addSubscriber('s1', ['brain:read']);
      const emitted = await mgr.catchUp('co_x');
      expect(emitted).toBe(2);
      expect(received.map((r) => r.event)).toEqual([
        expect.objectContaining({ factId: 'knowledge_fact:a', via: 'replay' }),
        expect.objectContaining({ factId: 'knowledge_fact:b', via: 'replay' }),
      ]);
    });

    it('does NOT re-deliver what the live socket already pushed', async () => {
      const mgr = makeManager();
      const { channel, received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [
          change(11, 'knowledge_fact:a', 'lives_in'),
          change(12, 'knowledge_fact:b', 'reads'),
        ],
      });
      addSubscriber('s1', ['brain:read']);
      channel.delivered.add('knowledge_fact:a'); // arrived over the socket
      const emitted = await mgr.catchUp('co_x');
      expect(emitted).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.event).toMatchObject({ factId: 'knowledge_fact:b' });
    });

    it('advances the cursor so the next tick does not repeat the batch', async () => {
      const mgr = makeManager();
      const { channel, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:a', 'p'), change(17, 'knowledge_fact:b', 'p')],
      });
      addSubscriber('s1', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(channel.versionstamp).toBe(17n);
    });

    it('ignores changes at or below the cursor (SINCE is inclusive)', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(10, 'knowledge_fact:old', 'p'), change(11, 'knowledge_fact:new', 'p')],
      });
      addSubscriber('s1', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(received.map((r) => (r.event as any).factId)).toEqual(['knowledge_fact:new']);
    });

    it('is a no-op for a tenant with no channel', async () => {
      await expect(makeManager().catchUp('co_missing')).resolves.toBe(0);
    });

    /**
     * A 3.x versionstamp is a u64 around 1.17e17, where a double's ULP is 16:
     * folded through Number(), a cursor and a later commit inside the same
     * millisecond round to the SAME value, and `vs <= cursor` then drops the
     * commit (or, the other way round, re-delivers one). The cursor and every
     * comparison are bigint end to end.
     */
    it('keeps u64 versionstamps exact past 2^53', async () => {
      const cursor = 117_000_000_000_000_001n;
      const next = 117_000_000_000_000_005n;
      expect(Number(next)).toBe(Number(cursor)); // both round to …000
      const mgr = makeManager();
      const { channel, received, addSubscriber } = installChannel(mgr, {
        versionstamp: cursor,
        changes: [change(next, 'knowledge_fact:u64', 'p')],
      });
      addSubscriber('s1', ['brain:read']);
      expect(await mgr.catchUp('co_x')).toBe(1);
      expect(received.map((r) => (r.event as any).factId)).toEqual(['knowledge_fact:u64']);
      expect(channel.versionstamp).toBe(next);
    });

    it('reads the changefeed SINCE the exact cursor, not a rounded one', async () => {
      const mgr = makeManager();
      const { queries } = installChannel(mgr, { versionstamp: 117_000_000_000_000_001n });
      await mgr.catchUp('co_x');
      expect(queries.join('\n')).toContain('SINCE 117000000000000001');
    });
  });

  describe('ABAC fence on delivery', () => {
    // A predicate the registry fences behind brain:read_pii.
    const lookup = (predicate: string) =>
      predicate === 'dob'
        ? { requiresScope: 'brain:read_pii', piiClass: 'direct' }
        : { piiClass: 'none' };

    it('withholds a scoped predicate from a subscriber without the scope', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('reader', ['brain:read'], lookup);
      await mgr.catchUp('co_x');
      expect(received).toHaveLength(0);
    });

    it('delivers the same event to a subscriber that HAS the scope', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('privileged', ['brain:read', 'brain:read_pii'], lookup);
      await mgr.catchUp('co_x');
      expect(received).toHaveLength(1);
    });

    it('fences per subscriber — one stream being allowed does not leak into another', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('privileged', ['brain:read', 'brain:read_pii'], lookup);
      addSubscriber('reader', ['brain:read'], lookup);
      await mgr.catchUp('co_x');
      expect(received.map((r) => r.sub)).toEqual(['privileged']);
    });
  });

  describe('session renewal', () => {
    /**
     * A subscription connection is the longest-lived connection in the
     * process, and surrealdb-js invalidates a `signin()`-established session
     * when its access token lapses — after which the LIVE stream is dead and
     * every catch-up tick fails with "Anonymous access not allowed" (audit
     * 2026-09-08, see src/db/session-keeper.ts). The catch-up tick is where
     * the session gets renewed.
     */
    it('signs the channel connection in on the first catch-up tick', async () => {
      const mgr = makeManager();
      const { signins } = installChannel(mgr, { versionstamp: 10n, changes: [] });
      await mgr.catchUp('co_x');
      expect(signins).toHaveLength(1);
    });

    it('does not re-sign while the token still has life left', async () => {
      const mgr = makeManager();
      const { signins } = installChannel(mgr, { versionstamp: 10n, changes: [] });
      await mgr.catchUp('co_x');
      await mgr.catchUp('co_x');
      await mgr.catchUp('co_x');
      // Renewal is driven by the token's own expiry, not by the tick — a
      // signin runs the server-side password KDF and must not ride every
      // catch-up interval.
      expect(signins).toHaveLength(1);
    });
  });

  /**
   * The database goes away and comes back (a restart, an upgrade, a network
   * partition longer than the driver's reconnect budget). The SDK brings the
   * socket back with an ANONYMOUS session and the standing LIVE query gone,
   * while the session keeper still holds a valid expiry — so a tick that
   * only re-signs "when the token is near expiry" fails the same way
   * forever and the subscribers starve in silence. The tick therefore probes
   * the connection the way every pool acquire does (`RETURN 1`), and rebuilds
   * the channel — fresh connection, fresh signin, fresh LIVE — replaying the
   * gap from the cursor it kept.
   */
  describe('recovery after the database restarts', () => {
    /** A replacement connection the rebuild can adopt, with its own LIVE. */
    function replacement(changes: any[] = []) {
      const sub = { kill: async () => {}, isAlive: true, subscribe: () => () => {} };
      const conn = {
        query: async (sql: string) => (sql.startsWith('RETURN') ? [1] : [changes]),
        signin: async () => ({ access: farFutureJwt() }),
        isConnected: true,
        accessToken: farFutureJwt(),
        subscribe: () => () => {},
        close: async () => {},
        live: async () => sub,
      };
      return { conn, sub };
    }

    it('rebuilds the channel when the session came back anonymous, and replays the gap', async () => {
      const mgr = makeManager();
      const missed = change(12, 'knowledge_fact:during_outage', 'p');
      const { channel, received, addSubscriber } = installChannel(mgr, { versionstamp: 10n });
      // The keeper holds a valid expiry, so nothing would re-sign on its own.
      (mgr as any).sessions.record(channel.conn, farFutureJwt());
      channel.conn.query = async () => {
        throw new Error('IAM error: Not enough permissions: Anonymous access not allowed');
      };
      const fresh = replacement([missed]);
      const open = jest.spyOn(mgr as any, 'openConnection').mockResolvedValue(fresh.conn as never);
      addSubscriber('s1', ['brain:read']);

      expect(await mgr.catchUp('co_x')).toBe(1);
      expect(open).toHaveBeenCalledWith('co_x');
      // The channel now rides the replacement, LIVE query included.
      expect(channel.conn).toBe(fresh.conn);
      expect(channel.sub).toBe(fresh.sub);
      // …and the change committed while the socket was dead was delivered.
      expect(received.map((r) => (r.event as any).factId)).toEqual([
        'knowledge_fact:during_outage',
      ]);
      expect(channel.versionstamp).toBe(12n);
    });

    it('rebuilds when the standing LIVE query is gone even though the socket answers', async () => {
      const mgr = makeManager();
      const { channel, addSubscriber } = installChannel(mgr, { versionstamp: 10n });
      (mgr as any).sessions.record(channel.conn, farFutureJwt());
      channel.sub.isAlive = false; // the driver could not restart it
      const fresh = replacement([change(11, 'knowledge_fact:after', 'p')]);
      jest.spyOn(mgr as any, 'openConnection').mockResolvedValue(fresh.conn as never);
      addSubscriber('s1', ['brain:read']);

      expect(await mgr.catchUp('co_x')).toBe(1);
      expect(channel.sub).toBe(fresh.sub);
    });

    it('a rebuild that cannot connect leaves the channel in place for the next tick', async () => {
      const mgr = makeManager();
      const { channel, addSubscriber } = installChannel(mgr, { versionstamp: 10n });
      (mgr as any).sessions.record(channel.conn, farFutureJwt());
      channel.sub.isAlive = false;
      jest
        .spyOn(mgr as any, 'openConnection')
        .mockRejectedValue(new Error('connect timed out') as never);
      addSubscriber('s1', ['brain:read']);

      await expect(mgr.catchUp('co_x')).rejects.toThrow(/connect timed out/);
      // Nothing was thrown away: the cursor and the subscribers survive, so
      // the interval's next tick tries again.
      expect((mgr as any).channels.get('co_x')).toBe(channel);
      expect(channel.versionstamp).toBe(10n);
      expect(channel.subscribers.size).toBe(1);
    });
  });

  describe('backpressure and lifecycle', () => {
    it('signals resync instead of growing an unbounded queue', async () => {
      const mgr = makeManager({ LIVE_MAX_QUEUE_PER_SUBSCRIBER: '0' });
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:a', 'p')],
      });
      addSubscriber('slow', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(received[0]!.event).toEqual({ kind: 'resync', reason: 'backpressure' });
    });

    it('drops a subscriber whose sink throws, without killing the stream', async () => {
      const mgr = makeManager();
      const { channel, received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10n,
        changes: [change(11, 'knowledge_fact:a', 'p')],
      });
      channel.subscribers.set('broken', {
        id: 'broken',
        callerScopes: ['brain:read'],
        sink: () => {
          throw new Error('client gone');
        },
        queued: 0,
      } as never);
      addSubscriber('healthy', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(channel.subscribers.has('broken')).toBe(false);
      expect(received.map((r) => r.sub)).toEqual(['healthy']);
    });

    it('refuses to subscribe while the flag is off (no socket is ever opened)', async () => {
      const mgr = makeManager();
      expect(mgr.isEnabled()).toBe(false);
      await expect(
        mgr.subscribe('co_x', { callerScopes: ['brain:read'], sink: () => {} }),
      ).rejects.toThrow(/disabled/);
    });

    it('caps concurrent subscribers per tenant', async () => {
      const mgr = makeManager({
        LIVE_SUBSCRIPTIONS_ENABLED: '1',
        LIVE_MAX_SUBSCRIBERS_PER_TENANT: '1',
      });
      const { addSubscriber } = installChannel(mgr);
      addSubscriber('first', ['brain:read']);
      await expect(
        mgr.subscribe('co_x', { callerScopes: ['brain:read'], sink: () => {} }),
      ).rejects.toThrow(/cap reached/);
    });

    it('releasing the last subscriber tears the channel down', async () => {
      const mgr = makeManager({ LIVE_SUBSCRIPTIONS_ENABLED: '1' });
      installChannel(mgr);
      const handle = await mgr.subscribe('co_x', {
        callerScopes: ['brain:read'],
        sink: () => {},
      });
      expect((mgr as any).channels.size).toBe(1);
      await handle.close();
      expect((mgr as any).channels.size).toBe(0);
    });
  });
});
