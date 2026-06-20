/**
 * Unit-test for CalibrationService.onModuleInit — verifies that a
 * persisted calibration_table row with sampleCount ≥ 40 supplants
 * the synthetic gold-set bootstrap; otherwise the synthetic bootstrap
 * stays in place.
 *
 * Closes the audit's "low-volume tenants stay on synthetic forever"
 * finding. Once the nightly refit (calibration-refit.service.ts) has
 * written a versioned row, every subsequent boot inherits it via
 * this path.
 */
import { CalibrationService } from '../src/ai/calibration/calibration.service';

interface FakeRow {
  thresholds: number[];
  values: number[];
  sampleCount: number;
}

function mkSvc(opts: {
  persistedRow?: FakeRow | null;
  apiKeysReturn?: string[];
  hasSurreal?: boolean;
}): CalibrationService {
  const config = {
    get: (k: string, def?: string) => {
      if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
      if (k === 'CALIBRATION_USE_GOLD_SET') return '1';
      return def;
    },
  } as any;
  const surreal =
    opts.hasSurreal === false
      ? undefined
      : ({
          withCompany: async (_c: string, fn: (db: any) => Promise<any>) => {
            const row = opts.persistedRow;
            const db = {
              query: async () => {
                if (row === null) return [[]];
                return [[row]];
              },
            };
            return fn(db);
          },
        } as any);
  const apiKeys = {
    knownCompanyIds: () => opts.apiKeysReturn ?? ['co_a'],
  } as any;
  return new CalibrationService(config, surreal, apiKeys);
}

describe('CalibrationService.onModuleInit — persisted bootstrap', () => {
  it('keeps synthetic when no persisted row exists', async () => {
    const svc = mkSvc({ persistedRow: null });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
  });

  it('keeps synthetic when persisted row has sampleCount < 40', async () => {
    const svc = mkSvc({
      persistedRow: {
        thresholds: [0.5, 1.0],
        values: [0.3, 0.7],
        sampleCount: 12,
      },
    });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
  });

  it('keeps synthetic when persisted row is malformed (length mismatch)', async () => {
    const svc = mkSvc({
      persistedRow: {
        thresholds: [0.5, 1.0],
        values: [0.3],
        sampleCount: 80,
      },
    });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
  });

  it('replaces synthetic when persisted row has sampleCount >= 40 + sane shape', async () => {
    const svc = mkSvc({
      persistedRow: {
        thresholds: [0.5, 0.8, 1.0],
        values: [0.25, 0.5, 0.75],
        sampleCount: 200,
      },
    });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('persisted');
    // Map applied — calibrate should now apply the persisted curve,
    // not the synthetic.
    const out = svc.calibrate(0.9);
    expect(out).toBe(0.75);
  });

  it('stays synthetic when no tenants are registered (knownCompanyIds empty)', async () => {
    const svc = mkSvc({
      persistedRow: { thresholds: [1], values: [0.5], sampleCount: 50 },
      apiKeysReturn: [],
    });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
  });

  it('stays synthetic when SurrealService is not injected (test fixtures)', async () => {
    const svc = mkSvc({ hasSurreal: false });
    await svc.onModuleInit();
    expect(svc.getBootstrapSource()).toBe('synthetic');
  });
});
