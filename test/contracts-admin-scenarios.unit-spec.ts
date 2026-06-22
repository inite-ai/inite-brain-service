/**
 * Wire-contract drift guard for GET /v1/admin/scenarios.
 */
import { ScenariosResponseSchema } from '../src/contracts/admin/scenarios.schema';
import { AdminEvalController } from '../src/admin/admin-eval.controller';
import type { ScenarioRunnerService } from '../src/admin/scenario-runner.service';

function makeController(): AdminEvalController {
  const scenarios = {
    list: () => [
      {
        id: 'kg.basic',
        vertical: 'cross',
        description: 'Basic ingest + search round-trip',
        setupSteps: 5,
        queries: 3,
        hasMemoryAssertions: false,
        hasIdentityMerge: false,
        hasSynthesize: false,
      },
      {
        id: 'identity.merge',
        vertical: 'identity',
        description: 'Identity merge survivor wins',
        setupSteps: 8,
        queries: 1,
        hasMemoryAssertions: true,
        hasIdentityMerge: true,
        hasSynthesize: false,
      },
    ],
  } as unknown as ScenarioRunnerService;
  const undef = undefined as unknown as never;
  return new AdminEvalController(scenarios, undef, undef);
}

describe('AdminEvalController.listScenarios() — wire contract', () => {
  it('matches ScenariosResponseSchema', () => {
    const parsed = ScenariosResponseSchema.safeParse(
      makeController().listScenarios(),
    );
    if (!parsed.success) {
      throw new Error(
        `scenarios drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
