/**
 * Wire-contract drift guard for the public /v1/sources surface
 * (trust-inputs track) — zod round-trips plus a regression fence
 * asserting the public declared shape can never regrow the operator
 * annotations (owner/note).
 */
import {
  PublicDeclaredSourceSchema,
  PublicSourceDetailResponseSchema,
  PublicSourcesListResponseSchema,
  PublicSourceSummarySchema,
} from '../src/contracts/sources/sources.schema';

const trustScope = {
  domain: null,
  agreementRate: 0.9,
  sampleCount: 12,
  winCount: 11,
  lossCount: 1,
  lastSeenAt: '2026-07-08T00:00:00.000Z',
};

const summary = {
  sourceKey: 'rent:senior_auditor',
  declared: { type: 'human', authLevel: 0.8 },
  globalTrust: trustScope,
  scopedDomains: 2,
};

describe('public sources — wire contracts', () => {
  it('PublicDeclaredSource has NO owner/note keys (regression fence)', () => {
    expect(Object.keys(PublicDeclaredSourceSchema.shape).sort()).toEqual([
      'authLevel',
      'type',
    ]);
  });

  it('PublicSourceSummary round-trips with and without domainTrust', () => {
    expect(PublicSourceSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      PublicSourceSummarySchema.safeParse({
        ...summary,
        domainTrust: { ...trustScope, domain: 'status' },
      }).success,
    ).toBe(true);
    expect(
      PublicSourceSummarySchema.safeParse({ ...summary, domainTrust: null })
        .success,
    ).toBe(true);
    // Either side of the join may be absent.
    expect(
      PublicSourceSummarySchema.safeParse({
        sourceKey: 'rent:_',
        declared: null,
        globalTrust: null,
        scopedDomains: 0,
      }).success,
    ).toBe(true);
  });

  it('PublicSourcesListResponse round-trips with paging metadata', () => {
    const parsed = PublicSourcesListResponseSchema.safeParse({
      sources: [summary],
      total: 41,
      limit: 50,
      offset: 0,
    });
    expect(parsed.success).toBe(true);
    expect(
      PublicSourcesListResponseSchema.safeParse({ sources: [summary] })
        .success,
    ).toBe(false);
  });

  it('PublicSourceDetailResponse round-trips and rejects a declared row with authLevel out of range', () => {
    expect(
      PublicSourceDetailResponseSchema.safeParse({
        sourceKey: 'rent:senior_auditor',
        declared: { type: 'human', authLevel: 0.8 },
        trust: [trustScope, { ...trustScope, domain: 'status' }],
        history: [
          {
            domain: null,
            agreementRate: 0.85,
            sampleCount: 10,
            recordedAt: '2026-07-01T03:42:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      PublicDeclaredSourceSchema.safeParse({ type: 'human', authLevel: 1.5 })
        .success,
    ).toBe(false);
    expect(
      PublicDeclaredSourceSchema.safeParse({ type: 'rumor_mill', authLevel: 1 })
        .success,
    ).toBe(false);
  });
});
