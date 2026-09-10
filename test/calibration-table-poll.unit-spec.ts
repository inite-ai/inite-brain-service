/**
 * CalibrationService polls calibration_table so a map refitted on the
 * replica that won the nightly lease reaches every other replica within
 * CALIBRATION_POLL_MS — the same raw confidence must calibrate the same
 * everywhere, not "persisted on the lease winner, synthetic elsewhere".
 */
import { CalibrationService, CALIBRATION_POLL_MS } from '../src/ai/calibration/calibration.service';

interface FakeRow {
  version: number;
  thresholds: number[];
  values: number[];
  sampleCount: number;
}

interface FakeState {
  row: FakeRow | null;
  tenants: string[];
  fail: boolean;
  reads: number;
}

const V2: FakeRow = {
  version: 2,
  thresholds: [0.5, 0.8, 1.0],
  values: [0.25, 0.5, 0.75],
  sampleCount: 200,
};
const V3: FakeRow = {
  version: 3,
  thresholds: [0.5, 0.8, 1.0],
  values: [0.2, 0.4, 0.6],
  sampleCount: 300,
};

function mkState(over: Partial<FakeState> = {}): FakeState {
  return { row: V2, tenants: ['co_a'], fail: false, reads: 0, ...over };
}

function mkSvc(state: FakeState): CalibrationService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
      if (k === 'CALIBRATION_USE_GOLD_SET') return '1';
      return def;
    },
  } as any;
  const surreal = {
    withCompany: async (_c: string, fn: (db: any) => Promise<any>) =>
      fn({
        query: async () => {
          state.reads += 1;
          if (state.fail) throw new Error('db down');
          return [state.row ? [state.row] : []];
        },
      }),
  } as any;
  const apiKeys = { knownCompanyIds: () => state.tenants } as any;
  return new CalibrationService(config, surreal, apiKeys);
}

describe('CalibrationService — calibration_table poll (replica coherence)', () => {
  let svc: CalibrationService | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    svc?.onModuleDestroy();
    svc = undefined;
    jest.useRealTimers();
  });

  it('installs a newer version written by another replica on the next tick', async () => {
    const state = mkState();
    svc = mkSvc(state);
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('persisted');
    expect(svc.calibrate(0.9)).toBe(0.75);

    state.row = V3; // the lease winner's nightly refit landed
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.calibrate(0.9)).toBe(0.6);
  });

  it('an unchanged table costs one read per tick and installs nothing', async () => {
    const state = mkState();
    svc = mkSvc(state);
    await svc.onModuleInit();
    expect(state.reads).toBe(1);

    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(state.reads).toBe(2);
    expect(svc.calibrate(0.9)).toBe(0.75);

    state.row = { ...V2, version: 1, values: [0.1, 0.1, 0.1] }; // older than what runs
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.calibrate(0.9)).toBe(0.75);
  });

  it('a newer persisted version wins over a map this process installed via loadMap', async () => {
    const state = mkState();
    svc = mkSvc(state);
    await svc.onModuleInit();
    svc.loadMap('gpt-test', 'bootstrap', { thresholds: [1], values: [0.11], sampleCount: 50 });
    expect(svc.calibrate(0.9)).toBe(0.11);

    state.row = V3;
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.calibrate(0.9)).toBe(0.6);
  });

  it('keeps polling when no tenant is known at boot and picks the row up once one registers', async () => {
    const state = mkState({ tenants: [] });
    svc = mkSvc(state);
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
    expect(state.reads).toBe(0);

    state.tenants = ['co_a'];
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.getBootstrapSource()).toBe('persisted');
    expect(svc.calibrate(0.9)).toBe(0.75);
  });

  it('a failing tick keeps the current map and retries on the next tick', async () => {
    const state = mkState();
    svc = mkSvc(state);
    await svc.onModuleInit();

    state.fail = true;
    state.row = V3;
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.calibrate(0.9)).toBe(0.75);

    state.fail = false;
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS);
    expect(svc.calibrate(0.9)).toBe(0.6);
  });

  it('onModuleDestroy stops the poll', async () => {
    const state = mkState();
    svc = mkSvc(state);
    await svc.onModuleInit();
    svc.onModuleDestroy();
    const before = state.reads;
    await jest.advanceTimersByTimeAsync(CALIBRATION_POLL_MS * 3);
    expect(state.reads).toBe(before);
  });
});
