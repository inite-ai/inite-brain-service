import { z } from 'zod';

/**
 * Wire contract for GET /v1/admin/scenarios.
 *
 * Mirrors ScenarioListItem from scenario-runner.service.ts.
 * Duplicated in brain-landing/lib/contracts/admin-scenarios.ts.
 */

const ScenarioListItemSchema = z.object({
  id: z.string(),
  vertical: z.string(),
  description: z.string(),
  setupSteps: z.number(),
  queries: z.number(),
  hasMemoryAssertions: z.boolean(),
  hasIdentityMerge: z.boolean(),
  hasSynthesize: z.boolean(),
});

export const ScenariosResponseSchema = z.object({
  scenarios: z.array(ScenarioListItemSchema),
});

export type ScenariosResponse = z.infer<typeof ScenariosResponseSchema>;
export type ScenarioListItem = z.infer<typeof ScenarioListItemSchema>;
