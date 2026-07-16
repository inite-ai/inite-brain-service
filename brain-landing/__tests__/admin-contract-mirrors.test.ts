/**
 * Contract-mirror fixtures for the Packs / Marketplace / Sources admin
 * panels. The BFF proxy 502s whenever a registered response schema fails
 * to parse — so a typo in a hand-copied mirror (lib/contracts/*) would
 * brick the panel even though the backend answers fine. These fixtures
 * are representative backend payloads; safeParse must accept them.
 */
import { describe, it, expect } from 'vitest'
import {
  InstallPackResponseSchema,
  PackEvalReportSchema,
  PacksListResponseSchema,
  UninstallPackResponseSchema,
} from '@/lib/contracts/admin-packs'
import {
  CheckoutResponseSchema,
  FeatureResponseSchema,
  PackPricingResponseSchema,
  PaymentRequiredHintSchema,
  PublisherProfileSchema,
  PublisherResponseSchema,
  RegistryListResponseSchema,
  RegistryPackSummarySchema,
  RegistryVersionsResponseSchema,
  YankPackResponseSchema,
} from '@/lib/contracts/admin-marketplace'
import {
  DeclareSourceResponseSchema,
  SourceDetailResponseSchema,
  SourcesListResponseSchema,
} from '@/lib/contracts/admin-sources'

describe('admin-packs mirrors', () => {
  it('parses GET /v1/admin/packs', () => {
    const fixture = {
      available: [
        {
          id: 'real_estate',
          version: '1.2.0',
          description: 'Property listings, valuations, transactions.',
          predicateCount: 24,
          builtin: true,
        },
      ],
      installed: [
        {
          packId: 'acme_crm',
          version: '0.3.1',
          installedAt: '2026-07-15T10:00:00.000Z',
          predicateCount: 12,
          checksum: 'a'.repeat(64),
        },
        {
          packId: 'legacy_pack',
          version: '0.1.0',
          installedAt: '2026-05-01T00:00:00.000Z',
          predicateCount: 3,
          checksum: null,
        },
      ],
    }
    expect(PacksListResponseSchema.safeParse(fixture).success).toBe(true)
  })

  it('parses InstallPackResponse without optionals', () => {
    const minimal = {
      packId: 'acme_crm',
      version: '0.3.1',
      predicatesSeeded: 12,
      checksum: 'b'.repeat(64),
    }
    expect(InstallPackResponseSchema.safeParse(minimal).success).toBe(true)
  })

  it('parses InstallPackResponse with seedDocuments + webhookSecret', () => {
    const full = {
      packId: 'acme_crm',
      version: '0.4.0',
      predicatesSeeded: 14,
      checksum: 'c'.repeat(64),
      seedDocuments: { count: 3, status: 'enqueued' },
      webhookSecret: 'f'.repeat(64),
    }
    expect(InstallPackResponseSchema.safeParse(full).success).toBe(true)
  })

  it('rejects an unknown seedDocuments status', () => {
    const bad = {
      packId: 'acme_crm',
      version: '0.4.0',
      predicatesSeeded: 14,
      checksum: 'c'.repeat(64),
      seedDocuments: { count: 3, status: 'exploded' },
    }
    expect(InstallPackResponseSchema.safeParse(bad).success).toBe(false)
  })

  it('parses a PackEvalReport with failures', () => {
    const report = {
      packId: 'acme_crm',
      version: '0.4.0',
      total: 2,
      passed: 1,
      results: [
        { id: 'fixture-1', passed: true, failures: [] },
        {
          id: 'fixture-2',
          passed: false,
          failures: ['expected predicate acme_crm__deal_stage not extracted'],
        },
      ],
    }
    expect(PackEvalReportSchema.safeParse(report).success).toBe(true)
  })

  it('parses UninstallPackResponse', () => {
    const fixture = { packId: 'acme_crm', predicatesDeprecated: 12 }
    expect(UninstallPackResponseSchema.safeParse(fixture).success).toBe(true)
  })
})

describe('admin-marketplace mirrors', () => {
  it('parses a RegistryPackSummary with marketplace fields', () => {
    const summary = {
      packId: 'fintech_kyc',
      latestVersion: '2.0.0',
      description: 'KYC entities and risk predicates.',
      keywords: ['fintech', 'kyc'],
      publisher: 'inite',
      signed: true,
      verified: true,
      downloads: 41,
      publishedAt: '2026-07-10T12:00:00.000Z',
      versionCount: 4,
      origin: 'https://registry.example.com',
      featured: true,
      featuredAt: '2026-07-12T09:00:00.000Z',
      paid: true,
      displayPrice: { amount: 1999, currency: 'USD' },
    }
    expect(RegistryPackSummarySchema.safeParse(summary).success).toBe(true)
  })

  it('parses a bare summary (defaults for verified/downloads)', () => {
    const bare = {
      packId: 'hr_basics',
      latestVersion: '1.0.0',
      description: 'HR ontology.',
      keywords: [],
      publisher: null,
      signed: false,
      versionCount: 1,
    }
    const parsed = RegistryPackSummarySchema.safeParse(bare)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.verified).toBe(false)
      expect(parsed.data.downloads).toBe(0)
    }
  })

  it('parses GET /v1/registry/packs and /v1/registry/packs/:packId', () => {
    const list = {
      packs: [
        {
          packId: 'hr_basics',
          latestVersion: '1.0.0',
          description: 'HR ontology.',
          keywords: [],
          publisher: null,
          signed: false,
          verified: false,
          downloads: 0,
          versionCount: 1,
        },
      ],
    }
    expect(RegistryListResponseSchema.safeParse(list).success).toBe(true)
    const versions = {
      packId: 'hr_basics',
      latestVersion: '1.0.0',
      versions: [
        {
          packId: 'hr_basics',
          version: '1.0.0',
          checksum: 'd'.repeat(64),
          description: 'HR ontology.',
          keywords: [],
          publisher: null,
          signed: false,
          verified: false,
          yanked: true,
          yankReason: 'broken extraction profile',
          publishedAt: '2026-07-01T00:00:00.000Z',
          downloads: 7,
        },
      ],
    }
    expect(RegistryVersionsResponseSchema.safeParse(versions).success).toBe(
      true,
    )
  })

  it('parses publisher profile + publisher response', () => {
    const profile = {
      publisher: 'inite',
      displayName: 'INITE',
      url: 'https://inite.ai',
      bio: 'First-party packs.',
      contactEmail: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: null,
    }
    expect(PublisherProfileSchema.safeParse(profile).success).toBe(true)
    const response = { publisher: 'inite', profile: null, packs: [] }
    expect(PublisherResponseSchema.safeParse(response).success).toBe(true)
  })

  it('parses pricing / feature / yank / checkout responses', () => {
    expect(
      PackPricingResponseSchema.safeParse({
        packId: 'fintech_kyc',
        paid: true,
        priceCode: 'price_123',
        displayPrice: { amount: 1999, currency: 'USD' },
      }).success,
    ).toBe(true)
    expect(
      PackPricingResponseSchema.safeParse({ packId: 'fintech_kyc', paid: false })
        .success,
    ).toBe(true)
    expect(
      FeatureResponseSchema.safeParse({ packId: 'fintech_kyc', featured: true })
        .success,
    ).toBe(true)
    expect(
      YankPackResponseSchema.safeParse({
        packId: 'fintech_kyc',
        version: '2.0.0',
        yanked: true,
      }).success,
    ).toBe(true)
    expect(
      CheckoutResponseSchema.safeParse({
        sessionId: 'cs_123',
        checkoutUrl: 'https://billing.example.com/checkout/cs_123',
      }).success,
    ).toBe(true)
  })

  it('parses the 402 PaymentRequiredHint (full + minimal)', () => {
    const full = {
      statusCode: 402,
      error: 'Payment Required',
      message:
        'pack "fintech_kyc" is a paid pack — purchase via the checkout endpoint, then retry',
      packId: 'fintech_kyc',
      priceCode: 'price_123',
      displayPrice: { amount: 1999, currency: 'USD' },
      checkout: {
        method: 'POST',
        path: '/v1/admin/registry/packs/fintech_kyc/checkout',
      },
    }
    expect(PaymentRequiredHintSchema.safeParse(full).success).toBe(true)
    const minimal = {
      statusCode: 402,
      error: 'Payment Required',
      message: 'paid pack',
      packId: 'fintech_kyc',
      checkout: {
        method: 'POST',
        path: '/v1/admin/registry/packs/fintech_kyc/checkout',
      },
    }
    expect(PaymentRequiredHintSchema.safeParse(minimal).success).toBe(true)
    // A consent 400 must NOT parse as a payment hint.
    expect(
      PaymentRequiredHintSchema.safeParse({ ...minimal, statusCode: 400 })
        .success,
    ).toBe(false)
  })
})

describe('admin-sources mirrors', () => {
  const globalTrust = {
    domain: null,
    agreementRate: 0.87,
    sampleCount: 123,
    winCount: 107,
    lossCount: 16,
    lastSeenAt: '2026-07-14T03:42:00.000Z',
  }

  it('parses GET /v1/admin/sources with absent sides', () => {
    const fixture = {
      sources: [
        {
          sourceKey: 'crm:agent-bot',
          declared: {
            sourceKey: 'crm:agent-bot',
            type: 'agent',
            authLevel: 0.6,
            owner: 'platform-team',
            note: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
          globalTrust,
          scopedDomains: 2,
        },
        {
          sourceKey: 'web:crawler',
          declared: null,
          globalTrust: null,
          scopedDomains: 0,
        },
      ],
    }
    expect(SourcesListResponseSchema.safeParse(fixture).success).toBe(true)
  })

  it('parses GET /v1/admin/sources/:sourceKey with history', () => {
    const detail = {
      sourceKey: 'crm:agent-bot',
      declared: null,
      trust: [
        globalTrust,
        { ...globalTrust, domain: 'finance', lastSeenAt: null },
      ],
      history: [
        {
          domain: null,
          agreementRate: 0.85,
          sampleCount: 110,
          recordedAt: '2026-07-13T03:42:00.000Z',
        },
        {
          domain: 'finance',
          agreementRate: 0.91,
          sampleCount: 34,
          recordedAt: '2026-07-12T03:42:00.000Z',
        },
      ],
    }
    expect(SourceDetailResponseSchema.safeParse(detail).success).toBe(true)
  })

  it('parses PUT /v1/admin/sources/:sourceKey response', () => {
    const fixture = {
      declared: {
        sourceKey: 'crm:agent-bot',
        type: 'agent',
        authLevel: 0.75,
        owner: null,
        note: 'primary ingest bot',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
    }
    expect(DeclareSourceResponseSchema.safeParse(fixture).success).toBe(true)
  })
})
