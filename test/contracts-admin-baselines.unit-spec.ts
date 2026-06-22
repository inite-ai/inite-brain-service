/**
 * Wire-contract drift guard for GET /v1/admin/baselines.
 *
 * The response is a raw array (not wrapped in { rows: ... }).
 * Verifying both shape and that the array stays at the top level.
 */
import { BaselinesResponseSchema } from '../src/contracts/admin/baselines.schema';
import { AdminEvalController } from '../src/admin/admin-eval.controller';
import type { BaselineService } from '../src/admin/baseline.service';

function makeController(): AdminEvalController {
  const baselines = {
    list: async () => [
      {
        name: '2026-06-22-v1',
        savedAt: new Date().toISOString(),
        scenarios: 10,
        meanRecallAt1: 0.92,
      },
    ],
  } as unknown as BaselineService;
  const undef = undefined as unknown as never;
  return new AdminEvalController(undef, baselines, undef);
}

describe('AdminEvalController.listBaselines() — wire contract', () => {
  it('matches BaselinesResponseSchema (raw array, not wrapped)', async () => {
    const payload = await makeController().listBaselines();
    expect(Array.isArray(payload)).toBe(true);
    const parsed = BaselinesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `baselines drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
