/**
 * Wire-contract drift guard for GET /v1/admin/calibration.
 *
 * Two-path coverage: with a fitted map (the enabled flow) and
 * without (the disabled flow). Schema is flat, both must parse.
 */
import { CalibrationResponseSchema } from '../src/contracts/admin/calibration.schema';
import { AdminController } from '../src/admin/admin.controller';
import type { CalibrationService } from '../src/ai/calibration/calibration.service';
import type { CalibrationRefitService } from '../src/ai/calibration/calibration-refit.service';

function makeController(
  calibration: CalibrationService,
  refit: CalibrationRefitService,
): AdminController {
  const undef = undefined as unknown as never;
   
  return new AdminController(
    undef, undef, undef, undef, undef, undef, undef, undef, calibration, refit,
  );
}

describe('AdminController.calibrationStats() — wire contract', () => {
  it('matches CalibrationResponseSchema in the enabled path', async () => {
    const calibration = {
      getMap: () => ({
        thresholds: [0.25, 0.5, 0.75, 1.0],
        values: [0.2, 0.45, 0.7, 0.95],
        sampleCount: 50,
      }),
      getBootstrapSource: () => 'synthetic' as const,
    } as unknown as CalibrationService;
    const refit = {
      listVersions: async () => [
        { version: 2, sampleCount: 80, bins: 8, createdAt: new Date().toISOString() },
      ],
    } as unknown as CalibrationRefitService;
    const parsed = CalibrationResponseSchema.safeParse(
      await makeController(calibration, refit).calibrationStats(),
    );
    if (!parsed.success) {
      throw new Error(
        `calibration (enabled) drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.data.disabled).toBe(false);
    expect(parsed.data.map).not.toBeNull();
  });

  it('matches CalibrationResponseSchema in the disabled path', async () => {
    const calibration = {
      getMap: () => null,
      getBootstrapSource: () => 'synthetic' as const,
    } as unknown as CalibrationService;
    const refit = {
      listVersions: async () => [],
    } as unknown as CalibrationRefitService;
    const parsed = CalibrationResponseSchema.safeParse(
      await makeController(calibration, refit).calibrationStats(),
    );
    if (!parsed.success) {
      throw new Error(
        `calibration (disabled) drifted: ${JSON.stringify(
          parsed.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(parsed.data.disabled).toBe(true);
    expect(parsed.data.map).toBeNull();
  });
});
