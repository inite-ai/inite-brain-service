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
import {
  DeleteConnectionResponseSchema,
  SourceCatalogResponseSchema,
  SourceConnectionSchema,
  SourceConnectionStatsSchema,
  SourceConnectionsListResponseSchema,
  SourceItemInspectResponseSchema,
  SourceItemsListResponseSchema,
  SourceRunsResponseSchema,
  SyncNowResponseSchema,
} from '@/lib/contracts/admin-source-connections'
import {
  IssuedKeyResponseSchema,
  KeyListResponseSchema,
} from '@/lib/contracts/admin-keys'
import { brainUrlOf } from '@/components/admin/connections/AgentSetupModal'

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

describe('admin-source-connections mirrors', () => {
  const connection = {
    id: 'source_connection:abc123',
    packId: 'file_memory',
    sourceId: 'folder',
    kind: 'native',
    connector: 'fs',
    shape: 'document',
    host: 'server',
    label: 'Handbook',
    config: { root: '/srv/docs', excludeDirs: ['node_modules'] },
    hasCredential: false,
    grantId: null,
    mode: 'synced',
    schedule: 'manual',
    contentPolicy: 'text',
    deletePolicy: 'close',
    fetchBudget: null,
    status: 'active',
    checkpoint: { walked: 12 },
    vertical: 'file_memory',
    recorder: 'srcconn_abc123',
    sourceKey: 'file_memory:srcconn_abc123',
    ownerUserId: null,
    lastSyncAt: '2026-09-16T10:00:00.000Z',
    lastSyncStatus: 'succeeded',
    lastError: null,
    createdAt: '2026-09-16T09:00:00.000Z',
    updatedAt: null,
  }

  it('parses GET / POST / PATCH /v1/admin/source-connections', () => {
    expect(SourceConnectionSchema.safeParse(connection).success).toBe(true)
    expect(
      SourceConnectionsListResponseSchema.safeParse({ connections: [connection] })
        .success,
    ).toBe(true)
  })

  it('parses GET …/:id/items', () => {
    const fixture = {
      items: [
        {
          id: 'source_item:1',
          connectionId: 'source_connection:abc123',
          externalId: 'guide/intro.md',
          originUri: 'file:///srv/docs/guide/intro.md',
          path: 'guide/intro.md',
          title: 'intro.md',
          mediaType: 'text/markdown',
          size: 1234,
          revision: '1726480000000:1234',
          fetchedRevision: '1726480000000:1234',
          modifiedAt: '2026-09-16T09:30:00.000Z',
          documentId: 'source_document:xyz',
          assetId: null,
          episodeId: null,
          state: 'indexed',
          firstSeenAt: '2026-09-16T09:31:00.000Z',
          lastSeenAt: '2026-09-16T10:00:00.000Z',
          goneAt: null,
          lastError: null,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    }
    expect(SourceItemsListResponseSchema.safeParse(fixture).success).toBe(true)
  })

  it('parses both shapes of POST …/:id/sync', () => {
    expect(
      SyncNowResponseSchema.safeParse({
        enqueued: true,
        runId: 'job_run:1',
        created: true,
      }).success,
    ).toBe(true)
    expect(
      SyncNowResponseSchema.safeParse({
        enqueued: false,
        summary: {
          connectionId: 'source_connection:abc123',
          mode: 'full',
          status: 'succeeded',
          seen: 3,
          new: 3,
          changed: 0,
          unchanged: 0,
          gone: 0,
          fetched: 3,
          ingested: 3,
          deduplicated: 0,
          failed: 0,
          closed: 0,
          durationMs: 120,
        },
      }).success,
    ).toBe(true)
  })

  it('parses DELETE …/:id', () => {
    expect(
      DeleteConnectionResponseSchema.safeParse({ deleted: true, items: 4 })
        .success,
    ).toBe(true)
  })

  it('parses GET …/catalog', () => {
    const fixture = {
      sources: [
        {
          packId: 'file_memory',
          packVersion: '0.2.0',
          builtin: false,
          accepted: true,
          sourceId: 'folder',
          kind: 'native',
          connector: 'fs',
          shape: 'document',
          title: 'Folder (text documents)',
          description: 'Text-like files under a directory.',
          defaults: {
            contentPolicy: 'text',
            deletePolicy: 'close',
            schedule: 'manual',
          },
          availability: 'disabled',
          configExample: { root: '/srv/docs' },
          credentialHint: null,
          hosts: ['server', 'agent'],
          mcp: null,
          oauth: null,
          records: null,
        },
        {
          packId: 'code_memory',
          packVersion: '0.8.0',
          builtin: true,
          accepted: true,
          sourceId: 'repository',
          kind: 'external',
          connector: 'external',
          shape: 'structure',
          title: null,
          description: null,
          defaults: {
            contentPolicy: 'manifest',
            deletePolicy: 'close',
            schedule: 'manual',
          },
          availability: 'external',
          configExample: null,
          credentialHint: null,
          hosts: ['server'],
          mcp: null,
          oauth: null,
          records: null,
        },
        {
          packId: 'web_memory',
          packVersion: '0.2.0',
          builtin: false,
          accepted: true,
          sourceId: 'mcp_resources',
          kind: 'mcp',
          connector: 'mcp',
          shape: 'document',
          title: 'MCP resources',
          description: null,
          defaults: {
            contentPolicy: 'text',
            deletePolicy: 'close',
            schedule: '24h',
          },
          availability: 'ready',
          configExample: { url: 'https://mcp.example.com/mcp' },
          credentialHint: 'bearer token',
          hosts: ['server'],
          mcp: {
            transport: 'http',
            url: null,
            auth: 'none',
            command: null,
            args: [],
          },
          oauth: null,
          records: null,
        },
      ],
      connectors: [
        { kind: 'fs', state: 'disabled', flag: 'SOURCE_KIND_FS' },
        { kind: 'url', state: 'ready', flag: 'SOURCE_KIND_URL' },
      ],
      fsRoots: [],
      egressAllowPrivate: false,
    }
    expect(SourceCatalogResponseSchema.safeParse(fixture).success).toBe(true)
  })

  it('parses the drill-down: stats, runs and one item followed to its facts', () => {
    expect(
      SourceConnectionStatsSchema.safeParse({
        connectionId: 'source_connection:abc123',
        items: { seen: 0, fetched: 1, indexed: 11, gone: 2, total: 14 },
        facts: { active: 40, stale: 3, closed: 5 },
      }).success,
    ).toBe(true)
    expect(
      SourceConnectionStatsSchema.safeParse({
        connectionId: 'source_connection:abc123',
        items: { seen: 0, fetched: 0, indexed: 0, gone: 0, total: 0 },
        facts: null,
      }).success,
    ).toBe(true)
    expect(
      SourceRunsResponseSchema.safeParse({
        connectionId: 'source_connection:abc123',
        persisted: true,
        runs: [
          {
            runId: 'r1',
            status: 'succeeded',
            ranBy: 'agent:laptop',
            triggeredBy: 'manual',
            startedAt: '2026-09-17T10:00:00.000Z',
            finishedAt: '2026-09-17T10:00:02.000Z',
            durationMs: 2000,
            mode: 'full',
            counters: {
              seen: 3,
              new: 3,
              changed: 0,
              unchanged: 0,
              gone: 0,
              fetched: 3,
              ingested: 3,
              deduplicated: 0,
              failed: 0,
              closed: 0,
            },
            skipped: null,
            error: null,
          },
          {
            runId: 'r0',
            status: 'running',
            ranBy: 'server',
            triggeredBy: 'cron',
            startedAt: '2026-09-17T09:00:00.000Z',
            finishedAt: null,
            durationMs: null,
            mode: null,
            counters: null,
            skipped: null,
            error: null,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      SourceItemInspectResponseSchema.safeParse({
        item: {
          id: 'source_item:i1',
          connectionId: 'source_connection:abc123',
          externalId: 'docs/intro.md',
          originUri: 'file:///srv/docs/docs/intro.md',
          path: 'docs/intro.md',
          title: 'intro.md',
          mediaType: 'text/markdown',
          size: 1234,
          revision: '1726480000000:1234',
          fetchedRevision: '1726480000000:1234',
          modifiedAt: '2026-09-16T09:30:00.000Z',
          documentId: 'source_document:xyz',
          assetId: null,
          episodeId: null,
          state: 'indexed',
          firstSeenAt: '2026-09-16T09:31:00.000Z',
          lastSeenAt: '2026-09-16T10:00:00.000Z',
          goneAt: null,
          lastError: null,
        },
        documents: [
          {
            id: 'source_document:xyz',
            title: 'intro.md',
            kind: 'file',
            status: 'active',
            originUri: 'file:///srv/docs/docs/intro.md',
            createdAt: '2026-09-16T09:31:00.000Z',
          },
        ],
        asset: {
          id: 'evidence_asset:a1',
          mediaType: 'application/pdf',
          modality: 'document',
          byteLength: 40960,
          availability: 'available',
          quarantineStatus: null,
          representations: [
            {
              id: 'derived_representation:d1',
              kind: 'text',
              producerVersion: 'document-text-v1',
              chars: 2048,
              createdAt: '2026-09-16T09:32:00.000Z',
            },
          ],
        },
        facts: [
          {
            id: 'knowledge_fact:f1',
            entityId: 'knowledge_entity:e1',
            predicate: 'file_memory__describes',
            object: 'payments gateway',
            confidence: 0.9,
            version: '1726480000000:1234',
            staleAt: null,
            staleReason: null,
            validUntil: null,
            status: 'active',
          },
        ],
        factsTruncated: false,
      }).success,
    ).toBe(true)
  })
})

describe('admin-keys mirrors', () => {
  const record = {
    id: 'api_key:abc',
    name: 'agent:laptop-1',
    prefix: 'key_ab12',
    scopes: ['brain:write'],
    createdAt: '2026-09-17T10:00:00.000Z',
  }
  it('parses GET / POST /v1/keys and derives the brain url from the MCP url', () => {
    const issued = {
      key: 'key_ab12cd34ef56',
      companyId: 'co_x',
      mcpUrl: 'https://brain.example/mcp/co_x',
      keyRecord: record,
    }
    expect(IssuedKeyResponseSchema.safeParse(issued).success).toBe(true)
    expect(brainUrlOf(issued)).toBe('https://brain.example')
    expect(brainUrlOf({ ...issued, mcpUrl: 'https://brain.example/other' })).toBe('https://brain.example/other')
    expect(
      KeyListResponseSchema.safeParse({
        companyId: 'co_x',
        mcpUrl: 'https://brain.example/mcp/co_x',
        keys: [record],
        issuingEnabled: true,
        issuableScopes: ['brain:read', 'brain:write'],
      }).success,
    ).toBe(true)
  })
})
