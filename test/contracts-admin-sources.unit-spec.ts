/**
 * Wire-contract drift guard for /v1/admin/sources (source-reputation
 * track, Phase 3).
 */
import {
  DeclareSourceResponseSchema,
  SourceDetailResponseSchema,
  SourcesListResponseSchema,
} from '../src/contracts/sources/sources.schema';
import { AdminSourcesController } from '../src/sources/admin-sources.controller';
import type { SourcesService } from '../src/sources/sources.service';
import type { AuthenticatedRequest } from '../src/auth/api-key.types';

const declared = {
  sourceKey: 'rent:senior_auditor',
  type: 'human' as const,
  authLevel: 0.8,
  owner: 'ops@inite.ai',
  note: null,
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
};

const trustScope = {
  domain: 'status',
  agreementRate: 0.9,
  sampleCount: 12,
  winCount: 11,
  lossCount: 1,
  lastSeenAt: '2026-07-08T00:00:00.000Z',
};

function makeController(): AdminSourcesController {
  const svc = {
    list: () =>
      Promise.resolve([
        {
          sourceKey: 'rent:senior_auditor',
          declared,
          globalTrust: { ...trustScope, domain: null },
          scopedDomains: 2,
        },
        {
          sourceKey: 'rent:_',
          declared: null,
          globalTrust: null,
          scopedDomains: 0,
        },
      ]),
    detail: () =>
      Promise.resolve({
        sourceKey: 'rent:senior_auditor',
        declared,
        trust: [{ ...trustScope, domain: null }, trustScope],
        history: [
          {
            domain: null,
            agreementRate: 0.85,
            sampleCount: 10,
            recordedAt: '2026-07-01T03:42:00.000Z',
          },
        ],
      }),
    declare: () => Promise.resolve(declared),
  } as unknown as SourcesService;
  return new AdminSourcesController(svc);
}

const req = {
  brainAuth: { companyId: 'co_test', scopes: ['brain:admin'] },
} as AuthenticatedRequest;

describe('AdminSourcesController — wire contracts', () => {
  it('list() matches SourcesListResponseSchema', async () => {
    const parsed = SourcesListResponseSchema.safeParse(
      await makeController().list(req),
    );
    expect(parsed.success).toBe(true);
  });

  it('detail() matches SourceDetailResponseSchema', async () => {
    const parsed = SourceDetailResponseSchema.safeParse(
      await makeController().detail(req, 'rent:senior_auditor'),
    );
    expect(parsed.success).toBe(true);
  });

  it('declare() matches DeclareSourceResponseSchema', async () => {
    const parsed = DeclareSourceResponseSchema.safeParse(
      await makeController().declare(req, 'rent:senior_auditor', {
        type: 'human',
        authLevel: 0.8,
      }),
    );
    expect(parsed.success).toBe(true);
  });
});
