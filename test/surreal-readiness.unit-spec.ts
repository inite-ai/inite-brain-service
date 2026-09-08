import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../src/db/surreal.service';

describe('SurrealService readiness under connection faults', () => {
  function setup() {
    const svc = new SurrealService(new ConfigService());
    const state = svc as any;
    state.scopedEnabled = true;
    state.scopedCreds = { username: 'reader', password: 'test', namespace: 'brain' };
    state.acquireTimeoutMs = 10_000;
    return { svc, state };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not report a slow, failing authentication as pool saturation', async () => {
    const { svc, state } = setup();
    const conn = { query: jest.fn() };
    state.scopedIdle.push(conn);
    jest
      .spyOn(state, 'ensureScopedSession')
      .mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('auth down')), 2500)),
      );
    let settled = false;
    const probe = svc.pingScoped().then((ready) => {
      settled = true;
      return ready;
    });
    await jest.advanceTimersByTimeAsync(2001);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(500);
    await expect(probe).resolves.toBe(false);
    expect(conn.query).not.toHaveBeenCalled();
    expect(state.scopedIdle).toEqual([conn]);
  });

  it('returns a late queued connection without leaking it or authenticating it', async () => {
    const { svc, state } = setup();
    const auth = jest.spyOn(state, 'ensureScopedSession');
    const probe = svc.pingScoped();
    await jest.advanceTimersByTimeAsync(2001);
    await expect(probe).resolves.toBe(true);
    const conn = {};
    state.releaseScoped(conn);
    await jest.advanceTimersByTimeAsync(0);
    expect(state.scopedIdle).toEqual([conn]);
    expect(auth).not.toHaveBeenCalled();
    expect(state.scopedWaiters).toHaveLength(0);
  });

  it('bounds a half-open socket ping instead of hanging the health endpoint', async () => {
    const { svc, state } = setup();
    state.all.push({ version: () => new Promise(() => undefined) });
    let result: boolean | undefined;
    const probe = svc.ping().then((ready) => {
      result = ready;
    });
    await jest.advanceTimersByTimeAsync(3001);
    expect(result).toBe(false);
    await probe;
  });

  it('renews the root session before tenant offboarding', async () => {
    const { svc, state } = setup();
    state.namespace = 'brain';
    let authorized = false;
    const conn = {
      signin: jest.fn(async () => {
        authorized = true;
      }),
      use: jest.fn(async () => undefined),
      query: jest.fn(async () => {
        if (!authorized) throw new Error('Anonymous access not allowed');
      }),
    };
    state.rootIdle.push(conn);
    await expect(svc.dropCompanyDatabase('offboarding')).resolves.toBeUndefined();
    expect(conn.query).toHaveBeenCalledWith('REMOVE DATABASE co_offboarding;');
    expect(state.rootIdle).toEqual([conn]);
  });
});
