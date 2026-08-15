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
    opts: { changes?: any[]; versionstamp?: number } = {},
  ) {
    const received: Array<{ sub: string; event: LiveEvent }> = [];
    const channel = {
      conn: {
        query: async () => [opts.changes ?? []],
      },
      sub: { kill: async () => {} },
      unsubscribe: () => {},
      subscribers: new Map(),
      versionstamp: opts.versionstamp ?? 10,
      delivered: new Set<string>(),
      timer: null,
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
    return { channel, received, addSubscriber };
  }

  const change = (versionstamp: number, id: string, predicate: string) => ({
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
      expect(
        toFactEvent({ recordId: 'knowledge_fact:f1', value: {} }, 'live'),
      ).toBeNull();
    });

    it('reads the changefeed shape, where the row sits under update/delete', () => {
      expect(
        toReplayEvent({ update: { id: 'knowledge_fact:f1', predicate: 'p', object: 'o' } })?.via,
      ).toBe('replay');
      expect(
        toReplayEvent({ delete: { id: 'knowledge_fact:f1', predicate: 'p' } })?.action,
      ).toBe('DELETE');
      expect(toReplayEvent({ define_table: {} })).toBeNull();
      expect(toReplayEvent(null)).toBeNull();
    });

    it('uses the double-prefixed tenant database name', () => {
      expect(dbNameFor('co_acme')).toBe('co_co_acme');
    });
  });

  describe('resume bridge', () => {
    it('replays changes the socket never delivered', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:a', 'lives_in'), change(12, 'knowledge_fact:b', 'reads')],
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
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:a', 'lives_in'), change(12, 'knowledge_fact:b', 'reads')],
      });
      addSubscriber('s1', ['brain:read']);
      channel.delivered.add('knowledge_fact:a'); // arrived over the socket
      const emitted = await mgr.catchUp('co_x');
      expect(emitted).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0].event).toMatchObject({ factId: 'knowledge_fact:b' });
    });

    it('advances the cursor so the next tick does not repeat the batch', async () => {
      const mgr = makeManager();
      const { channel, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:a', 'p'), change(17, 'knowledge_fact:b', 'p')],
      });
      addSubscriber('s1', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(channel.versionstamp).toBe(17);
    });

    it('ignores changes at or below the cursor (SINCE is inclusive)', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(10, 'knowledge_fact:old', 'p'), change(11, 'knowledge_fact:new', 'p')],
      });
      addSubscriber('s1', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(received.map((r) => (r.event as any).factId)).toEqual([
        'knowledge_fact:new',
      ]);
    });

    it('is a no-op for a tenant with no channel', async () => {
      await expect(makeManager().catchUp('co_missing')).resolves.toBe(0);
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
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('reader', ['brain:read'], lookup);
      await mgr.catchUp('co_x');
      expect(received).toHaveLength(0);
    });

    it('delivers the same event to a subscriber that HAS the scope', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('privileged', ['brain:read', 'brain:read_pii'], lookup);
      await mgr.catchUp('co_x');
      expect(received).toHaveLength(1);
    });

    it('fences per subscriber — one stream being allowed does not leak into another', async () => {
      const mgr = makeManager();
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:pii', 'dob')],
      });
      addSubscriber('privileged', ['brain:read', 'brain:read_pii'], lookup);
      addSubscriber('reader', ['brain:read'], lookup);
      await mgr.catchUp('co_x');
      expect(received.map((r) => r.sub)).toEqual(['privileged']);
    });
  });

  describe('backpressure and lifecycle', () => {
    it('signals resync instead of growing an unbounded queue', async () => {
      const mgr = makeManager({ LIVE_MAX_QUEUE_PER_SUBSCRIBER: '0' });
      const { received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
        changes: [change(11, 'knowledge_fact:a', 'p')],
      });
      addSubscriber('slow', ['brain:read']);
      await mgr.catchUp('co_x');
      expect(received[0].event).toEqual({ kind: 'resync', reason: 'backpressure' });
    });

    it('drops a subscriber whose sink throws, without killing the stream', async () => {
      const mgr = makeManager();
      const { channel, received, addSubscriber } = installChannel(mgr, {
        versionstamp: 10,
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
