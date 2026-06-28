/**
 * Wire-contract drift guards for write-side admin endpoints.
 *
 * Each test exercises a controller (with mocked deps) on a POST/DELETE
 * path and feeds the result through the corresponding response schema.
 * If the controller drifts from the schema, the test fails and the BFF
 * would 502 in prod for the same drift.
 *
 * All endpoints in one file because each test is small (write-side
 * shapes are mostly envelope-style { accepted: true, ... }).
 */
import {
  DropTenantResponseSchema,
  DlqDeleteResponseSchema,
  JobCancelResponseSchema,
  AcceptedDreamsResponseSchema,
  AcceptedCompactionResponseSchema,
  AcceptedCalibrationRefitResponseSchema,
  AcceptedReindexResponseSchema,
  AcceptedScenariosBatchResponseSchema,
  ChangefeedDrainResponseSchema,
  PredicateMutationResponseSchema,
  PredicateDeprecateResponseSchema,
  DreamsRunResponseSchema,
  ReindexRunResponseSchema,
  BaselineSaveResponseSchema,
  BaselineDiffResponseSchema,
} from '../src/contracts/admin/write-responses.schema';
import { makeAdminController } from './helpers/admin-controllers';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import { AdminJobsController } from '../src/admin/admin-jobs.controller';
import { AdminEvalController } from '../src/admin/admin-eval.controller';
import { AdminPredicatesController } from '../src/admin/admin-predicates.controller';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

const undef = undefined as unknown as never;

function assertParses(schema: { safeParse: (x: unknown) => { success: boolean; error?: { issues: unknown } } }, payload: unknown, label: string) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${label} drifted: ${JSON.stringify(parsed.error?.issues, null, 2)}`,
    );
  }
}

describe('write-side wire contracts', () => {
  it('AdminController.dropTenant() matches DropTenantResponseSchema', async () => {
    const admin = {
      dropTenantDatabase: async () => undefined,
    };

    const ctl = makeAdminController({ admin });
    const payload = await ctl.dropTenant('eval_test123');
    assertParses(DropTenantResponseSchema, payload, 'tenants drop');
  });

  it('AdminController.runDreams() matches DreamsRunResponseSchema', async () => {
    const dreams = {
      runForTenant: async () => ({
        companyId: 'tenant-a',
        durationSeconds: 12.5,
        dedup: {
          suspectsEvaluated: 5,
          llmJudgements: 3,
          identityLinksCreated: 1,
          unsurePairs: 1,
          identityLinks: [
            { survivorId: 'e:1', loserId: 'e:2', cosine: 0.94 },
          ],
        },
      }),
    } as never;
     
    const ctl = makeAdminController({ dreams });
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = await ctl.runDreams(req, { operations: ['dedup'] } as never);
    assertParses(DreamsRunResponseSchema, payload, 'dreams/run');
  });

  it('AdminController.reindexEmbeddings() matches ReindexRunResponseSchema', async () => {
    const reindex = {
      run: async () => ({
        tenantsScanned: 2,
        factsScanned: 100,
        factsUpdated: 80,
        durationMs: 1234,
        dryRun: false,
        provider: 'bge-m3',
      }),
    } as never;
     
    const ctl = makeAdminController({ reindex });
    const payload = await ctl.reindexEmbeddings();
    assertParses(ReindexRunResponseSchema, payload, 'reindex/embeddings');
  });

  it('AdminOpsController.dlqDelete() matches DlqDeleteResponseSchema', async () => {
    const admin = {
      deleteDeadLetter: async () => true,
    } as never;
    const ctl = new AdminOpsController(admin, undef, undef);
    const payload = await ctl.dlqDelete('tenant-a', 'dlq:1');
    assertParses(DlqDeleteResponseSchema, payload, 'dlq DELETE');
  });

  it('AdminJobsController.cancelJob() matches JobCancelResponseSchema', async () => {
    const jobs = {
      requestCancel: async () => true,
    } as never;
     
    const ctl = new AdminJobsController(
      jobs, undef, undef, undef, undef, undef, undef, undef, undef, undef,
      undef, undef, undef, undef, undef,
    );
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = await ctl.cancelJob(req, 'run-1');
    assertParses(JobCancelResponseSchema, payload, 'jobs/:runId/cancel');
  });

  it('AdminJobsController.triggerDreams() matches AcceptedDreamsResponseSchema', () => {
    const dreams = {
      runForTenant: async () => ({}),
    } as never;
     
    const ctl = new AdminJobsController(
      undef, dreams, undef, undef, undef, undef, undef, undef, undef, undef,
      undef, undef, undef, undef, undef,
    );
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = ctl.triggerDreams(req);
    assertParses(AcceptedDreamsResponseSchema, payload, 'maintenance/dreams/run');
  });

  it('AdminJobsController.triggerCompaction() matches AcceptedCompactionResponseSchema', () => {
    const apiKeys = {
      knownCompanyIds: () => ['tenant-a', 'tenant-b'],
    } as never;
    const compaction = {
      compactCompany: async () => undefined,
    } as never;
     
    const ctl = new AdminJobsController(
      undef, undef, undef, undef, undef, undef, apiKeys, undef, undef,
      undef, undef, undef, undef, compaction, undef,
    );
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = ctl.triggerCompaction(req);
    assertParses(
      AcceptedCompactionResponseSchema,
      payload,
      'maintenance/compaction',
    );
  });

  it('AdminJobsController.triggerCalibrationRefit() matches AcceptedCalibrationRefitResponseSchema', () => {
    const refit = {
      refitCalibration: async () => undefined,
      refitSourceTrust: async () => undefined,
    } as never;
     
    const ctl = new AdminJobsController(
      undef, undef, refit, undef, undef, undef, undef, undef, undef,
      undef, undef, undef, undef, undef, undef,
    );
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = ctl.triggerCalibrationRefit(req);
    assertParses(
      AcceptedCalibrationRefitResponseSchema,
      payload,
      'maintenance/calibration-refit',
    );
  });

  it('AdminJobsController.drainChangefeed() matches ChangefeedDrainResponseSchema', async () => {
    const changefeed = {
      drainNow: async () => ({
        consumed: { knowledge_fact: 42, knowledge_entity: 7 },
        pendingRemaining: 0,
        tenants: 2,
      }),
    } as never;
     
    const ctl = new AdminJobsController(
      undef, undef, undef, changefeed, undef, undef, undef, undef, undef,
      undef, undef, undef, undef, undef, undef,
    );
    const payload = await ctl.drainChangefeed();
    assertParses(ChangefeedDrainResponseSchema, payload, 'changefeed/drain');
  });

  it('AdminEvalController.saveBaseline() matches BaselineSaveResponseSchema', async () => {
    const baselines = {
      save: async () => ({
        name: 'v1',
        savedAt: new Date().toISOString(),
        scenarios: 3,
        meanRecallAt1: 0.91,
      }),
    } as never;
    const ctl = new AdminEvalController(undef, baselines, undef);
    const payload = await ctl.saveBaseline('v1', {
      outcomes: [{ metrics: { recallAt1: 1 } }] as never,
    });
    assertParses(BaselineSaveResponseSchema, payload, 'baselines/:name');
  });

  it('AdminEvalController.diffBaseline() matches BaselineDiffResponseSchema', async () => {
    const baselines = {
      diff: async () => ({
        baseline: 'v1',
        entries: [
          {
            scenarioId: 'kg.basic',
            metric: 'recallAt1' as const,
            baseline: 0.9,
            current: 0.85,
            delta: -0.05,
            verdict: 'regression' as const,
          },
        ],
      }),
    } as never;
    const ctl = new AdminEvalController(undef, baselines, undef);
    const payload = await ctl.diffBaseline('v1', { outcomes: [] });
    assertParses(BaselineDiffResponseSchema, payload, 'baselines/:name/diff');
  });

  it('AdminPredicatesController.deprecate() matches PredicateDeprecateResponseSchema', async () => {
    const registry = {
      deprecate: async () => true,
    } as never;
    const ctl = new AdminPredicatesController(registry);
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = await ctl.deprecate(req, 'has_email');
    assertParses(
      PredicateDeprecateResponseSchema,
      payload,
      'predicates DELETE',
    );
  });

  it('AdminPredicatesController.promote() matches PredicateMutationResponseSchema', async () => {
    const registry = {
      promote: async () => ({
        predicateId: 'has_email',
        displayLabel: 'Has email',
        description: 'desc',
        datatype: 'string' as const,
        semantics: 'single_active' as const,
        decayHalfLifeDays: null,
        piiClass: 'identifier' as const,
        status: 'active' as const,
        createdBy: 'admin' as const,
      }),
    } as never;
    const ctl = new AdminPredicatesController(registry);
    const req = {
      brainAuth: { companyId: 'tenant-a' },
    } as unknown as AuthenticatedRequest;
    const payload = await ctl.promote(req, 'has_email');
    assertParses(
      PredicateMutationResponseSchema,
      payload,
      'predicates promote',
    );
  });
});

describe('write-side accepted-envelope schemas exist for trigger endpoints', () => {
  // Sanity check that the accepted-envelope schemas pin the
  // discriminator literals — drift to a different jobType would be
  // a breaking change for the operator UI tab routing.
  it('AcceptedReindexResponseSchema accepts the canonical shape', () => {
    assertParses(
      AcceptedReindexResponseSchema,
      { accepted: true, runId: 'run-1' },
      'accepted/reindex',
    );
  });

  it('AcceptedScenariosBatchResponseSchema accepts the canonical shape', () => {
    assertParses(
      AcceptedScenariosBatchResponseSchema,
      { accepted: true, runId: 'run-1', scenarioCount: 5 },
      'accepted/scenarios-batch',
    );
  });
});
