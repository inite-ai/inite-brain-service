import { ForbiddenException } from '@nestjs/common';
import { LiveSubscriptionManager, type LiveEvent } from '../src/live/live-subscription.manager';
import { captureLiveReadFence, type LiveReadFence } from '../src/live/live-read-fence';
import { runWithRequestContext, type RequestContext } from '../src/common/request-context';
import { rememberScopeTags } from '../src/auth/scope-principal';
import { compilePolicySet } from '../src/policy/policy-compile';
import { CompiledPolicySet, PolicyContext, PolicyDocumentSchema } from '../src/policy/policy.types';

/**
 * The live fact stream pushes a row only to a subscriber that could read it
 * on any documented read surface: the per-user fence (userReadFence), the
 * scope-tag / circle fence (visibleUnderScope) and the row policy
 * (predicate scope gate + ABAC with the subscriber's own context).
 *
 * The subscriber's identity is captured inside its request
 * (captureLiveReadFence) and the events are pushed with no request context
 * at all — or, for the LIVE path, from inside an UNRELATED request's
 * context, which is what happens in production: the channel's socket is
 * opened on the first subscriber's stack.
 */
describe('live fact stream — read fences', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SCOPE_TAGS_ENABLED;
    delete process.env.READ_SURFACE_USER_SCOPE;
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  // `dob` is fenced behind brain:read_pii by the tenant registry.
  const lookup = (predicate: string) =>
    predicate === 'dob'
      ? { requiresScope: 'brain:read_pii', piiClass: 'direct' }
      : { piiClass: 'none' };

  /** The four rows of the scenario, as SHOW CHANGES post-images. */
  const ROWS = {
    global: { id: 'knowledge_fact:global', predicate: 'lives_in', object: 'Dublin', scope: [] },
    userB: {
      id: 'knowledge_fact:userB',
      predicate: 'prefers',
      object: 'tea',
      userId: 'userB',
      scope: ['user:userB'],
    },
    circle: {
      id: 'knowledge_fact:circle',
      predicate: 'said_in_session',
      object: 'something private to the circle',
      scope: ['circle:c1'],
    },
    pii: { id: 'knowledge_fact:pii', predicate: 'dob', object: '1990-01-01', scope: [] },
  } as const;
  type RowName = keyof typeof ROWS;
  const nameOf = (factId: string) =>
    (Object.keys(ROWS) as RowName[]).find((k) => ROWS[k].id === factId);

  function ctx(extra: Partial<RequestContext> = {}): RequestContext {
    return { correlationId: 'req', ...extra };
  }

  /** Resolve a fence exactly as the controller does, inside the request. */
  function fenceIn(c: RequestContext, userId?: string, before?: () => void): LiveReadFence {
    return runWithRequestContext(c, () => {
      before?.();
      return captureLiveReadFence(userId);
    });
  }

  function makeManager() {
    const config = { get: (_k: string, d?: string) => d } as never;
    return new LiveSubscriptionManager(config);
  }

  /** A network-free channel; `live` is the LIVE handler once attached. */
  function installChannel(mgr: LiveSubscriptionManager, changes: unknown[] = []) {
    const received: Array<{ sub: string; event: LiveEvent }> = [];
    let liveHandler: ((msg: unknown) => void) | undefined;
    const channel = {
      conn: {
        query: async (sql: string) => (sql.startsWith('RETURN') ? [1] : [changes]),
        signin: async () => ({ access: undefined }),
        isConnected: true,
        accessToken: 'x',
        subscribe: () => () => {},
        close: async () => {},
      },
      sub: {
        kill: async () => {},
        isAlive: true,
        subscribe: (h: (msg: unknown) => void) => {
          liveHandler = h;
          return () => {};
        },
      },
      unsubscribe: () => {},
      subscribers: new Map(),
      versionstamp: 10n,
      delivered: new Set<string>(),
      timer: null,
      catchingUp: false,
      liveBroken: false,
    };
    (mgr as any).channels.set('co_x', channel);
    // Never re-sign during the test.
    (mgr as any).sessions = { needsSignin: () => false, record: () => {}, forget: () => {} };
    channel.unsubscribe = (mgr as any).attach('co_x', channel);
    const add = (id: string, scopes: string[], fence: LiveReadFence) =>
      channel.subscribers.set(id, {
        id,
        callerScopes: scopes,
        fence,
        policyLookup: lookup,
        sink: (event: LiveEvent) => received.push({ sub: id, event }),
        queued: 0,
      });
    const live = (row: Record<string, unknown>) =>
      liveHandler!({ action: 'CREATE', recordId: row.id, value: row });
    return { channel, received, add, live };
  }

  const READ = ['brain:read'];
  const READ_PII = ['brain:read', 'brain:read_pii'];

  /** Every subscriber of the scenario and the rows it must receive. */
  function scenario() {
    const m2m = fenceIn(ctx());
    const m2mUserB = fenceIn(ctx(), 'userB');
    const userA = fenceIn(ctx({ authUserId: 'userA' }));
    const userB = fenceIn(ctx({ authUserId: 'userB' }));
    // userA is a member of circle c1 (the guard warmed the expansion).
    const userAInC1 = fenceIn(ctx({ authUserId: 'userA' }), undefined, () =>
      rememberScopeTags('userA', ['user:userA', 'circle:c1']),
    );
    // A credential bound to another circle, naming no user.
    const boundToC2 = fenceIn(ctx({ actingCircle: 'c2' }));
    return [
      ['m2m', READ, m2m, ['global', 'circle']],
      ['m2m+pii', READ_PII, m2m, ['global', 'circle', 'pii']],
      ['m2m?userId=userB', READ, m2mUserB, ['global', 'userB']],
      ['userA', READ, userA, ['global']],
      ['userB', READ, userB, ['global', 'userB']],
      ['userB+pii', READ_PII, userB, ['global', 'userB', 'pii']],
      ['userA in c1', READ, userAInC1, ['global', 'circle']],
      ['bound to c2', READ, boundToC2, ['global']],
    ] as const;
  }

  function delivered(received: Array<{ sub: string; event: LiveEvent }>, sub: string) {
    return received
      .filter((r) => r.sub === sub && r.event.kind === 'fact')
      .map((r) => nameOf((r.event as { factId: string }).factId))
      .sort();
  }

  it('LIVE path: each subscriber receives exactly the rows it may read', () => {
    const mgr = makeManager();
    const { received, add, live } = installChannel(mgr);
    const subs = scenario();
    for (const [name, scopes, fence] of subs) add(name, [...scopes], fence);
    // Pushed from inside an unrelated user's request context: the fences
    // must not read it.
    runWithRequestContext(ctx({ authUserId: 'userB' }), () => {
      for (const row of Object.values(ROWS)) live({ ...row });
    });
    for (const [name, , , expected] of subs) {
      expect({ name, rows: delivered(received, name) }).toEqual({
        name,
        rows: [...expected].sort(),
      });
    }
  });

  it('replay path (changefeed catch-up) applies the same fences', async () => {
    const mgr = makeManager();
    const changes = Object.values(ROWS).map((row, i) => ({
      versionstamp: 11 + i,
      changes: [{ update: { ...row } }],
    }));
    const { received, add } = installChannel(mgr, changes);
    const subs = scenario();
    for (const [name, scopes, fence] of subs) add(name, [...scopes], fence);
    await mgr.catchUp('co_x');
    for (const [name, , , expected] of subs) {
      expect({ name, rows: delivered(received, name) }).toEqual({
        name,
        rows: [...expected].sort(),
      });
    }
  });

  it("never pushes another user's personal fact (regression: the stream had no user fence)", () => {
    const mgr = makeManager();
    const { received, add, live } = installChannel(mgr);
    add('m2m', READ, fenceIn(ctx()));
    add('userA', READ, fenceIn(ctx({ authUserId: 'userA' })));
    live({ ...ROWS.userB });
    expect(received).toEqual([]);
  });

  it('does not put userId or scope on the wire event', () => {
    const mgr = makeManager();
    const { received, add, live } = installChannel(mgr);
    add('userB', READ, fenceIn(ctx({ authUserId: 'userB' })));
    live({ ...ROWS.userB });
    expect(received).toHaveLength(1);
    expect(Object.keys(received[0]!.event).sort()).toEqual(
      ['action', 'entityId', 'factId', 'kind', 'object', 'predicate', 'via'].sort(),
    );
  });

  it('a user-bound token naming another user is refused at subscribe time', () => {
    expect(() => fenceIn(ctx({ authUserId: 'userA' }), 'userB')).toThrow(ForbiddenException);
  });

  it('fails closed on a row whose scope is not a string array', () => {
    const mgr = makeManager();
    const { received, add, live } = installChannel(mgr);
    add('userB', READ, fenceIn(ctx({ authUserId: 'userB' })));
    live({ ...ROWS.global, scope: 'user:userB' });
    expect(received).toEqual([]);
  });

  it('with READ_SURFACE_USER_SCOPE cleared, a user token reads tenant-global rows only', () => {
    process.env.READ_SURFACE_USER_SCOPE = '0';
    const mgr = makeManager();
    const { received, add, live } = installChannel(mgr);
    add('userB', READ, fenceIn(ctx({ authUserId: 'userB' })));
    live({ ...ROWS.userB });
    live({ ...ROWS.global });
    expect(delivered(received, 'userB')).toEqual(['global']);
  });

  describe('ABAC with the subscriber’s own policy context', () => {
    function policyDenying(predicate: string): PolicyContext {
      const parsed = PolicyDocumentSchema.parse({
        name: 'live-test',
        description: '',
        posture: { actions: 'allow', reads: 'allow' },
        mode: 'enforce',
        rules: [
          {
            id: 'no-pred',
            enabled: true,
            effect: 'deny',
            kind: 'source',
            match: [{ attr: 'predicate', op: 'eq', value: predicate }],
          },
        ],
      });
      return {
        companyId: 'co_x',
        keyHash: 'sha256:live',
        sets: [compilePolicySet(parsed) as CompiledPolicySet],
        forceReportOnly: false,
        resolutionError: false,
      };
    }

    it('denies per subscriber and records the decision on that subscriber’s recorder', () => {
      const mgr = makeManager();
      const { received, add, live } = installChannel(mgr);
      const recorded: unknown[] = [];
      const policy = policyDenying('lives_in');
      add('policied', READ, fenceIn(ctx({ policy, recordPolicyRows: (s) => recorded.push(s) })));
      add('free', READ, fenceIn(ctx()));
      // Pushed inside a context carrying NO policy: the captured one applies.
      runWithRequestContext(ctx(), () => live({ ...ROWS.global }));
      expect(received.map((r) => r.sub)).toEqual(['free']);
      expect(recorded).toHaveLength(1);
    });

    it('a subscriber without policies is not denied by a policy on the push stack', () => {
      const mgr = makeManager();
      const { received, add, live } = installChannel(mgr);
      add('free', READ, fenceIn(ctx()));
      runWithRequestContext(ctx({ policy: policyDenying('lives_in') }), () =>
        live({ ...ROWS.global }),
      );
      expect(received.map((r) => r.sub)).toEqual(['free']);
    });
  });
});
