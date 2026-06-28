/**
 * Regression test for the calibration bootstrap-key mismatch.
 *
 * The nightly refit persisted its global row under the literal
 * promptHash `'bootstrap'`, while CalibrationService's boot loader
 * queried for `promptHashOf('bootstrap')` (a SHA-256 slice). The two
 * never matched, so every restart silently reverted to the synthetic
 * gold-set bootstrap and persisted nightly refits were never reloaded.
 *
 * This test pins the contract: the promptHash bound by the refit's
 * persist path and the one bound by the loader's read path MUST be
 * identical — and MUST be the hashed form, not the literal.
 */
import {
  CalibrationService,
  BOOTSTRAP_PROMPT_HASH,
  BOOTSTRAP_PROMPT_KEY,
  promptHashOf,
} from '../src/ai/calibration/calibration.service';
import { CalibrationRefitRunnerService } from '../src/ai/calibration/calibration-refit-runner.service';

function fakeSurreal(capture: Array<Record<string, any>>) {
  return {
    withCompany: async (_c: string, fn: (db: any) => Promise<any>) =>
      fn({
        query: async (_sql: string, binds?: Record<string, any>) => {
          if (binds) capture.push(binds);
          return [[]];
        },
      }),
  } as any;
}

const config = {
  get: (k: string, d?: string) => {
    if (k === 'OPENAI_CHAT_MODEL') return 'gpt-test';
    if (k === 'CALIBRATION_NIGHTLY_REFIT') return 'true';
    if (k === 'CALIBRATION_USE_GOLD_SET') return '1';
    return d;
  },
} as any;

describe('calibration bootstrap promptHash — persist/load contract', () => {
  it('refit persist and loader read bind the identical hashed promptHash', async () => {
    const binds: Array<Record<string, any>> = [];
    const surreal = fakeSurreal(binds);
    const apiKeys = { knownCompanyIds: () => ['co_a'] } as any;

    // Write side.
    const refit = new CalibrationRefitRunnerService(surreal, {} as any, apiKeys);
    await (refit as any).persistCalibrationMap({
      thresholds: [1],
      values: [0.5],
      sampleCount: 99,
    });

    // Read side.
    const calib = new CalibrationService(config, surreal, apiKeys);
    await calib.onModuleInit();

    const promptHashes = binds
      .filter((b) => 'p' in b)
      .map((b) => b.p as string);

    expect(promptHashes.length).toBeGreaterThan(0);
    for (const p of promptHashes) {
      expect(p).toBe(BOOTSTRAP_PROMPT_HASH);
    }
    // The regression: the literal must NOT be used; the canonical key is
    // the SHA-256 slice that the runtime calibrate() path also derives.
    expect(BOOTSTRAP_PROMPT_HASH).toBe(promptHashOf('bootstrap'));
    expect(BOOTSTRAP_PROMPT_HASH).not.toBe('bootstrap');
  });

  describe('loadMap ↔ calibrate cache-key contract (no double-hash)', () => {
    const map = { thresholds: [1], values: [0.42], sampleCount: 99 };

    it('a map loaded under BOOTSTRAP_PROMPT_KEY is read by calibrate default', () => {
      // This is the key the refit MUST pass to loadMap. loadMap re-hashes
      // internally, and calibrate(default promptText='bootstrap') reads
      // promptHashOf('bootstrap') — so the raw literal must round-trip.
      const svc = new CalibrationService(config);
      svc.loadMap('gpt-test', BOOTSTRAP_PROMPT_KEY, map as any);
      expect(svc.calibrate(0.9, 'gpt-test')).toBe(0.42);
    });

    it('loading under the already-hashed key MISSES calibrate (documents the trap)', () => {
      // Passing BOOTSTRAP_PROMPT_HASH to loadMap (which re-hashes) lands
      // the map under promptHashOf(HASH) — the exact double-hash bug.
      const svc = new CalibrationService(config);
      svc.loadMap('gpt-test', BOOTSTRAP_PROMPT_HASH, map as any);
      expect(svc.calibrate(0.9, 'gpt-test')).not.toBe(0.42);
    });
  });
});
