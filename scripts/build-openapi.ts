#!/usr/bin/env -S npx ts-node -T
/**
 * build-openapi — assemble the OpenAPI 3.1 document for the PLATFORM
 * surface (the community-facing API: pack registry, pack admin, document
 * ingest/read, external-indexer candidates + work discovery, source
 * reputation reads). The admin/ops surface (jobs, leases, policy, stats,
 * maintenance) is out of scope on purpose.
 *
 * components.schemas are GENERATED from the zod wire contracts under
 * src/contracts/ (zod v4 z.toJSONSchema over a registry, so nested
 * contracts become $refs). zod's default output is JSON Schema 2020-12,
 * which OpenAPI 3.1 accepts natively — no down-conversion. paths are
 * hand-written below against the controllers they document.
 *
 * Output: docs/openapi.json (committed artifact, keys sorted so
 * regenerate-and-diff is deterministic).
 *
 * Run:
 *   pnpm openapi:build
 *
 * Drift gate: test/openapi-doc.unit-spec.ts re-builds the document and
 * asserts deep-equality with the committed file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DomainPackManifestSchema,
  PublisherResponseSchema,
  PublishPackRequestSchema,
  PublishPackResponseSchema,
  RegistryListResponseSchema,
  RegistryManifestResponseSchema,
  RegistryPackSummarySchema,
  RegistryVersionSchema,
  RegistryVersionsResponseSchema,
  YankPackRequestSchema,
  YankPackResponseSchema,
} from '../src/contracts/registry/registry.schema';
import {
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  DisplayPriceSchema,
  FeatureResponseSchema,
  PackPricingResponseSchema,
  PaymentRequiredHintSchema,
  PublisherProfileSchema,
  SetPricingRequestSchema,
  UpsertPublisherProfileRequestSchema,
} from '../src/contracts/registry/marketplace.schema';
import {
  AvailablePackSchema,
  InstalledPackSchema,
  InstallFromRegistryRequestSchema,
  InstallPackRequestSchema,
  InstallPackResponseSchema,
  PackEvalFixtureResultSchema,
  PackEvalReportSchema,
  PacksListResponseSchema,
  UninstallPackResponseSchema,
} from '../src/contracts/admin/packs.schema';
import {
  PublicDeclaredSourceSchema,
  PublicSourceDetailResponseSchema,
  PublicSourceSummarySchema,
  PublicSourcesListResponseSchema,
  SOURCE_TYPES,
  SourceHistoryRowSchema,
  TrustScopeRowSchema,
} from '../src/contracts/sources/sources.schema';
import {
  ClaimWorkResponseSchema,
  FailWorkResponseSchema,
  HeartbeatWorkResponseSchema,
  IndexerWorkItemSchema,
  IndexerWorkListResponseSchema,
  WorkContentChunkSchema,
  WorkContentResponseSchema,
} from '../src/contracts/indexer/indexer-work.schema';
import {
  CandidateSchema,
  CommitCountsSchema,
  DocumentCandidatesResponseSchema,
  DocumentChunkSchema,
  DocumentContextRefSchema,
  DocumentResponseSchema,
  FailWorkRequestSchema,
  GroundingDropSchema,
  HeartbeatWorkRequestSchema,
  IngestDocumentAsyncResponseSchema,
  IngestDocumentRequestSchema,
  IngestDocumentSyncResponseSchema,
  SubmitCandidatesRequestSchema,
  SubmitCandidatesResponseSchema,
  SubmittedEntitySchema,
  SubmittedFactSchema,
  SubmittedRelationSchema,
} from '../src/contracts/documents/documents.schema';
import {
  CreateEpisodeSubscriptionRequestSchema,
  CreateEpisodeSubscriptionResponseSchema,
  DeleteEpisodeSubscriptionResponseSchema,
  EpisodeSubscriptionRowSchema,
  EpisodeSubscriptionsListResponseSchema,
  EpisodesAvailableEventSchema,
  EpisodesListResponseSchema,
  EpisodeWireSchema,
  ProjectionRowSchema,
  ProjectionsListResponseSchema,
  RebuildProjectionRequestSchema,
  RebuildProjectionResponseSchema,
} from '../src/contracts/episodes/driver.schema';
import {
  FactProvenanceEpisodeSchema,
  FactProvenanceResponseSchema,
  FactReadResponseSchema,
} from '../src/contracts/facts/facts.schema';
import {
  BeliefReadResponseSchema,
  BeliefsListResponseSchema,
} from '../src/contracts/beliefs/beliefs.schema';
import {
  ProfileFactSchema,
  ProfileSectionSchema,
  UserProfileResponseSchema,
} from '../src/contracts/users/user-profile.schema';
import { EvidenceRawUrlResponseSchema } from '../src/contracts/evidence/raw.schema';

type Json = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * components.schemas — generated from the zod contracts.
 * ------------------------------------------------------------------ */

/** Every zod contract exposed as a named component. Nested contracts
 *  listed here become `$ref`s inside their parents. */
const ZOD_COMPONENTS: Record<string, z.ZodType> = {
  // --- global pack registry (src/contracts/registry/registry.schema.ts)
  DomainPackManifest: DomainPackManifestSchema,
  PublishPackRequest: PublishPackRequestSchema,
  PublishPackResponse: PublishPackResponseSchema,
  RegistryListResponse: RegistryListResponseSchema,
  RegistryManifestResponse: RegistryManifestResponseSchema,
  RegistryPackSummary: RegistryPackSummarySchema,
  RegistryVersion: RegistryVersionSchema,
  RegistryVersionsResponse: RegistryVersionsResponseSchema,
  YankPackRequest: YankPackRequestSchema,
  YankPackResponse: YankPackResponseSchema,
  PublisherResponse: PublisherResponseSchema,
  // --- registry marketplace (src/contracts/registry/marketplace.schema.ts)
  CheckoutRequest: CheckoutRequestSchema,
  CheckoutResponse: CheckoutResponseSchema,
  DisplayPrice: DisplayPriceSchema,
  FeatureResponse: FeatureResponseSchema,
  PackPricingResponse: PackPricingResponseSchema,
  PaymentRequiredHint: PaymentRequiredHintSchema,
  PublisherProfile: PublisherProfileSchema,
  SetPricingRequest: SetPricingRequestSchema,
  UpsertPublisherProfileRequest: UpsertPublisherProfileRequestSchema,
  // --- tenant pack admin (src/contracts/admin/packs.schema.ts)
  AvailablePack: AvailablePackSchema,
  InstalledPack: InstalledPackSchema,
  InstallFromRegistryRequest: InstallFromRegistryRequestSchema,
  InstallPackRequest: InstallPackRequestSchema,
  InstallPackResponse: InstallPackResponseSchema,
  PackEvalFixtureResult: PackEvalFixtureResultSchema,
  PackEvalReport: PackEvalReportSchema,
  PacksListResponse: PacksListResponseSchema,
  UninstallPackResponse: UninstallPackResponseSchema,
  // --- document pipeline (src/contracts/documents/documents.schema.ts)
  Candidate: CandidateSchema,
  CommitCounts: CommitCountsSchema,
  DocumentCandidatesResponse: DocumentCandidatesResponseSchema,
  DocumentChunk: DocumentChunkSchema,
  DocumentContextRef: DocumentContextRefSchema,
  DocumentResponse: DocumentResponseSchema,
  GroundingDrop: GroundingDropSchema,
  IngestDocumentAsyncResponse: IngestDocumentAsyncResponseSchema,
  IngestDocumentRequest: IngestDocumentRequestSchema,
  IngestDocumentSyncResponse: IngestDocumentSyncResponseSchema,
  SubmitCandidatesRequest: SubmitCandidatesRequestSchema,
  SubmitCandidatesResponse: SubmitCandidatesResponseSchema,
  SubmittedEntity: SubmittedEntitySchema,
  SubmittedFact: SubmittedFactSchema,
  SubmittedRelation: SubmittedRelationSchema,
  // --- source reputation reads (src/contracts/sources/sources.schema.ts)
  PublicDeclaredSource: PublicDeclaredSourceSchema,
  PublicSourceDetailResponse: PublicSourceDetailResponseSchema,
  PublicSourceSummary: PublicSourceSummarySchema,
  PublicSourcesListResponse: PublicSourcesListResponseSchema,
  SourceHistoryRow: SourceHistoryRowSchema,
  TrustScopeRow: TrustScopeRowSchema,
  // --- external-indexer work discovery (src/contracts/indexer/…)
  ClaimWorkResponse: ClaimWorkResponseSchema,
  FailWorkRequest: FailWorkRequestSchema,
  FailWorkResponse: FailWorkResponseSchema,
  HeartbeatWorkRequest: HeartbeatWorkRequestSchema,
  HeartbeatWorkResponse: HeartbeatWorkResponseSchema,
  IndexerWorkItem: IndexerWorkItemSchema,
  IndexerWorkListResponse: IndexerWorkListResponseSchema,
  WorkContentChunk: WorkContentChunkSchema,
  WorkContentResponse: WorkContentResponseSchema,
  // --- raw-substrate driver (src/contracts/episodes/driver.schema.ts)
  EpisodeWire: EpisodeWireSchema,
  EpisodesListResponse: EpisodesListResponseSchema,
  ProjectionRow: ProjectionRowSchema,
  ProjectionsListResponse: ProjectionsListResponseSchema,
  RebuildProjectionRequest: RebuildProjectionRequestSchema,
  RebuildProjectionResponse: RebuildProjectionResponseSchema,
  CreateEpisodeSubscriptionRequest: CreateEpisodeSubscriptionRequestSchema,
  CreateEpisodeSubscriptionResponse: CreateEpisodeSubscriptionResponseSchema,
  EpisodeSubscriptionRow: EpisodeSubscriptionRowSchema,
  EpisodeSubscriptionsListResponse: EpisodeSubscriptionsListResponseSchema,
  DeleteEpisodeSubscriptionResponse: DeleteEpisodeSubscriptionResponseSchema,
  EpisodesAvailableEvent: EpisodesAvailableEventSchema,
  // --- fact read + provenance (src/contracts/facts/facts.schema.ts)
  FactReadResponse: FactReadResponseSchema,
  FactProvenanceEpisode: FactProvenanceEpisodeSchema,
  FactProvenanceResponse: FactProvenanceResponseSchema,
  // --- belief reads (src/contracts/beliefs/beliefs.schema.ts)
  BeliefReadResponse: BeliefReadResponseSchema,
  BeliefsListResponse: BeliefsListResponseSchema,
  // --- rolling user profile (src/contracts/users/user-profile.schema.ts)
  ProfileFact: ProfileFactSchema,
  ProfileSection: ProfileSectionSchema,
  UserProfileResponse: UserProfileResponseSchema,
  // --- raw-evidence read gateway (src/contracts/evidence/raw.schema.ts)
  EvidenceRawUrlResponse: EvidenceRawUrlResponseSchema,
};

function generateComponentSchemas(): Json {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(ZOD_COMPONENTS)) {
    registry.add(schema, { id });
  }
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
  });
  const out: Json = {};
  for (const [id, schema] of Object.entries(schemas)) {
    // $schema/$id are legal but redundant inside components (3.1 defaults
    // to the 2020-12 dialect; the component key is the identity).
    const { $schema, $id, ...clean } = schema as Json;
    void $schema;
    void $id;
    out[id] = clean;
  }
  // The Nest HttpException wire shape — hand-written (no zod contract:
  // it is framework-owned, not one of ours).
  out.ErrorResponse = {
    type: 'object',
    description: 'Standard NestJS error envelope.',
    properties: {
      statusCode: { type: 'integer' },
      message: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      error: { type: 'string' },
    },
    required: ['statusCode', 'message'],
  };
  out.FeatureDisabledResponse = {
    type: 'object',
    description:
      'Answered by every document-pipeline route while ' + 'DOCUMENT_INGEST_ENABLED is off.',
    properties: {
      error: { type: 'string', const: 'feature_disabled' },
      message: { type: 'string' },
    },
    required: ['error', 'message'],
  };
  return out;
}

/* ------------------------------------------------------------------ *
 * Small path-building helpers.
 * ------------------------------------------------------------------ */

const ref = (name: string): Json => ({
  $ref: `#/components/schemas/${name}`,
});
const errorRef = (name: string): Json => ({
  $ref: `#/components/responses/${name}`,
});

function jsonBody(schema: Json, description?: string): Json {
  return {
    required: true,
    ...(description ? { description } : {}),
    content: { 'application/json': { schema } },
  };
}

function jsonResponse(description: string, schema: Json): Json {
  return { description, content: { 'application/json': { schema } } };
}

function pathParam(name: string, description: string): Json {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  };
}

function queryParam(name: string, description: string, schema?: Json): Json {
  return {
    name,
    in: 'query',
    required: false,
    description,
    schema: schema ?? { type: 'string' },
  };
}

interface OperationSpec {
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  /** Bearer-key scope the route's @RequireScopes guard demands. */
  scope: string;
  parameters?: Json[];
  requestBody?: Json;
  responses: Json;
}

function operation(spec: OperationSpec): Json {
  return {
    operationId: spec.operationId,
    tags: [spec.tag],
    summary: spec.summary,
    description: `${spec.description}\n\nRequired scope: \`${spec.scope}\`.`,
    ...(spec.parameters ? { parameters: spec.parameters } : {}),
    ...(spec.requestBody ? { requestBody: spec.requestBody } : {}),
    responses: spec.responses,
  };
}

const AUTH_ERRORS: Json = {
  '401': errorRef('Unauthorized'),
  '403': errorRef('Forbidden'),
};
/** Everything behind the DOCUMENT_INGEST_ENABLED dark-launch flag. */
const FLAG_GATED: Json = { ...AUTH_ERRORS, '503': errorRef('FeatureDisabled') };

const FLAG_NOTE =
  'Part of the document pipeline — answers `503 feature_disabled` until ' +
  '`DOCUMENT_INGEST_ENABLED=1`.';

/* ------------------------------------------------------------------ *
 * paths — hand-written for the platform surface only.
 * ------------------------------------------------------------------ */

function registryPaths(): Json {
  return {
    '/v1/registry/packs': {
      get: operation({
        operationId: 'listRegistryPacks',
        tag: 'Registry',
        summary: 'Browse the global Domain Pack catalogue',
        description:
          'Lists published packs (latest installable version each). The ' +
          'catalogue is shared across all tenants; any authenticated key ' +
          'may browse. Source: src/registry/registry.controller.ts.',
        scope: 'brain:read',
        parameters: [
          queryParam('q', 'Substring match on pack id / description.'),
          queryParam('publisher', 'Filter by publisher id.'),
          queryParam('tag', 'Filter by keyword tag.'),
          queryParam('limit', 'Page size.', { type: 'integer' }),
          queryParam('offset', 'Page offset.', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('The catalogue page.', ref('RegistryListResponse')),
          ...AUTH_ERRORS,
        },
      }),
    },
    '/v1/registry/packs/{packId}': {
      get: operation({
        operationId: 'getRegistryPackVersions',
        tag: 'Registry',
        summary: "One pack's published version history",
        description:
          'All published versions of a pack, newest first, including ' + 'yanked ones (flagged).',
        scope: 'brain:read',
        parameters: [pathParam('packId', 'The pack id.')],
        responses: {
          '200': jsonResponse(
            'Version history (empty list when the pack is unknown).',
            ref('RegistryVersionsResponse'),
          ),
          ...AUTH_ERRORS,
        },
      }),
    },
    '/v1/registry/packs/{packId}/{version}': {
      get: operation({
        operationId: 'getRegistryPackManifest',
        tag: 'Registry',
        summary: 'Resolve one version to its full manifest',
        description:
          'Returns the full manifest body for install/inspection. ' +
          '`latest` is an alias for the latest non-yanked version.',
        scope: 'brain:read',
        parameters: [
          pathParam('packId', 'The pack id.'),
          pathParam('version', 'A published version, or `latest`.'),
        ],
        responses: {
          '200': jsonResponse('The resolved manifest.', ref('RegistryManifestResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/registry/packs': {
      post: operation({
        operationId: 'publishRegistryPack',
        tag: 'Registry publishing',
        summary: 'Publish a pack version to the global registry',
        description:
          'Versions are immutable once published. Republishing an ' +
          'identical (packId, version, checksum) is idempotent ' +
          '(`created: false`); a different body for an existing version ' +
          'is rejected. Source: src/registry/admin-registry.controller.ts.',
        scope: 'registry:publish',
        requestBody: jsonBody(ref('PublishPackRequest')),
        responses: {
          '201': jsonResponse('Published (or already present).', ref('PublishPackResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '409': errorRef('Conflict'),
        },
      }),
    },
    '/v1/admin/registry/packs/{packId}/{version}/yank': {
      post: operation({
        operationId: 'yankRegistryPack',
        tag: 'Registry publishing',
        summary: 'Yank a published version',
        description:
          'Marks a version as not-installable (existing installs keep ' +
          'working). The version stays visible in the history, flagged.',
        scope: 'registry:publish',
        parameters: [
          pathParam('packId', 'The pack id.'),
          pathParam('version', 'The published version to yank.'),
        ],
        requestBody: jsonBody(ref('YankPackRequest')),
        responses: {
          '201': jsonResponse('Yank state after the call.', ref('YankPackResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/registry/packs/{packId}/{version}/unyank': {
      post: operation({
        operationId: 'unyankRegistryPack',
        tag: 'Registry publishing',
        summary: 'Restore a yanked version',
        description: 'Reverses a yank — the version becomes installable again.',
        scope: 'registry:publish',
        parameters: [
          pathParam('packId', 'The pack id.'),
          pathParam('version', 'The yanked version to restore.'),
        ],
        responses: {
          '201': jsonResponse('Yank state after the call.', ref('YankPackResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/registry/publishers/{publisher}': {
      get: operation({
        operationId: 'getRegistryPublisher',
        tag: 'Registry',
        summary: "A publisher's public page as JSON",
        description:
          'The publisher profile (when one was written — see PUT ' +
          '/v1/admin/registry/publishers/{publisher}) plus the ' +
          "publisher's catalogue entries. 404 only when the publisher " +
          'is entirely unknown (no profile AND no packs). ' +
          'Source: src/registry/registry.controller.ts.',
        scope: 'brain:read',
        parameters: [pathParam('publisher', 'The publisher id (trust-store key id).')],
        responses: {
          '200': jsonResponse('The publisher page.', ref('PublisherResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
  };
}

function marketplacePaths(): Json {
  return {
    '/v1/admin/registry/packs/{packId}/pricing': {
      put: operation({
        operationId: 'setRegistryPackPricing',
        tag: 'Marketplace',
        summary: 'Price a pack (publisher-owned)',
        description:
          'Marks the pack paid: ensures the billing product exists ' +
          '(entitlement key `domain_pack:<packId>`), mints a fresh ' +
          'immutable price, and stores the priceCode + display price in ' +
          'the instance-local registry meta. Only the company that ' +
          'published the pack may price it. Answers 400 while the ' +
          'billing integration is disabled. ' +
          'Source: src/registry/marketplace-admin.controller.ts.',
        scope: 'registry:publish',
        parameters: [pathParam('packId', 'The pack id.')],
        requestBody: jsonBody(ref('SetPricingRequest')),
        responses: {
          '200': jsonResponse('The pricing state.', ref('PackPricingResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
      delete: operation({
        operationId: 'clearRegistryPackPricing',
        tag: 'Marketplace',
        summary: 'Make a pack free again (publisher-owned)',
        description:
          'Clears the paid flag — installs stop requiring an ' +
          'entitlement. Billing products/prices are immutable and stay.',
        scope: 'registry:publish',
        parameters: [pathParam('packId', 'The pack id.')],
        responses: {
          '200': jsonResponse('The pricing state.', ref('PackPricingResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/registry/packs/{packId}/feature': {
      post: operation({
        operationId: 'featureRegistryPack',
        tag: 'Marketplace',
        summary: 'Feature a pack (hosting-operator curation)',
        description:
          'Surfaces the pack in the featured section on top of the ' +
          'catalogue listing and /registry/ui. Instance-local; never ' +
          'mirrored.',
        scope: 'registry:curate',
        parameters: [pathParam('packId', 'The pack id.')],
        responses: {
          '201': jsonResponse('The curation state.', ref('FeatureResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/registry/packs/{packId}/unfeature': {
      post: operation({
        operationId: 'unfeatureRegistryPack',
        tag: 'Marketplace',
        summary: 'Remove a pack from the featured section',
        description: 'Reverses a feature.',
        scope: 'registry:curate',
        parameters: [pathParam('packId', 'The pack id.')],
        responses: {
          '201': jsonResponse('The curation state.', ref('FeatureResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/registry/publishers/{publisher}': {
      put: operation({
        operationId: 'upsertRegistryPublisherProfile',
        tag: 'Marketplace',
        summary: "Write a publisher's public profile",
        description:
          'Full-replace upsert. Writable ONLY by a company that has ' +
          'published at least one VERIFIED pack under the publisher id — ' +
          'the ed25519 signature validated against the hosting ' +
          "instance's trust store is what ties a company to the " +
          'publisher name (403 otherwise).',
        scope: 'registry:publish',
        parameters: [pathParam('publisher', 'The publisher id (trust-store key id).')],
        requestBody: jsonBody(ref('UpsertPublisherProfileRequest')),
        responses: {
          '200': jsonResponse('The stored profile.', ref('PublisherProfile')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
        },
      }),
    },
    '/v1/admin/registry/packs/{packId}/checkout': {
      post: operation({
        operationId: 'createRegistryPackCheckout',
        tag: 'Marketplace',
        summary: 'Start a hosted checkout for a paid pack',
        description:
          'Creates a billing checkout session for the BUYING tenant ' +
          "(the caller's company is the billing userId). Open " +
          '`checkoutUrl`, pay, then retry ' +
          'POST /v1/admin/packs/from-registry — the 402 hint on that ' +
          'route points here. Answers 400 for a free pack or while the ' +
          'billing integration is disabled. An `idempotency-key` header ' +
          'is forwarded to billing so client retries collapse into one ' +
          'order. Throttled to 10 requests/min per credential.',
        scope: 'brain:admin',
        parameters: [pathParam('packId', 'The paid pack id.')],
        requestBody: jsonBody(ref('CheckoutRequest')),
        responses: {
          '201': jsonResponse('The checkout session.', ref('CheckoutResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
          '429': errorRef('TooManyRequests'),
          '502': errorRef('BadGateway'),
          '503': errorRef('BillingUnavailable'),
        },
      }),
    },
  };
}

function packsAdminPaths(): Json {
  return {
    '/v1/admin/packs': {
      get: operation({
        operationId: 'listDomainPacks',
        tag: 'Domain Packs',
        summary: 'List available + installed packs for this tenant',
        description:
          'Builtin packs are globally available and cannot be installed ' +
          'or uninstalled here. Source: src/admin/admin-packs.controller.ts.',
        scope: 'brain:admin',
        responses: {
          '200': jsonResponse('Available and installed packs.', ref('PacksListResponse')),
          ...AUTH_ERRORS,
        },
      }),
      post: operation({
        operationId: 'installDomainPack',
        tag: 'Domain Packs',
        summary: 'Install a pack manifest into this tenant',
        description:
          'Validates and installs a community / custom manifest, seeding ' +
          'its predicates. `expectedChecksum` pins the exact content.',
        scope: 'brain:admin',
        requestBody: jsonBody(ref('InstallPackRequest')),
        responses: {
          '201': jsonResponse('Installed.', ref('InstallPackResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
        },
      }),
    },
    '/v1/admin/packs/from-registry': {
      post: operation({
        operationId: 'installDomainPackFromRegistry',
        tag: 'Domain Packs',
        summary: 'Install a pack from the global registry',
        description:
          'Resolves the manifest (latest non-yanked, or a pinned version) ' +
          'and installs it with the registry checksum pinned — the ' +
          'installed content is exactly what the registry served. A PAID ' +
          'pack without an active `domain_pack:<packId>` entitlement ' +
          'answers 402 with a self-describing hint (the checkout route ' +
          'to call, then retry); while the billing service is ' +
          'unreachable, paid installs fail CLOSED with 503.',
        scope: 'brain:admin',
        requestBody: jsonBody(ref('InstallFromRegistryRequest')),
        responses: {
          '201': jsonResponse('Installed.', ref('InstallPackResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '402': jsonResponse(
            'Paid pack, no entitlement — purchase via the checkout ' +
              'route in the hint, then retry.',
            ref('PaymentRequiredHint'),
          ),
          '404': errorRef('NotFound'),
          '502': errorRef('BadGateway'),
          '503': errorRef('BillingUnavailable'),
        },
      }),
    },
    '/v1/admin/packs/{packId}': {
      delete: operation({
        operationId: 'uninstallDomainPack',
        tag: 'Domain Packs',
        summary: 'Uninstall a pack from this tenant',
        description: "Deprecates the pack's predicates; facts extracted with them " + 'survive.',
        scope: 'brain:admin',
        parameters: [pathParam('packId', 'The installed pack id.')],
        responses: {
          '200': jsonResponse('Uninstalled.', ref('UninstallPackResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/packs/{packId}/eval': {
      post: operation({
        operationId: 'evalDomainPack',
        tag: 'Domain Packs',
        summary: "Run a pack's eval fixtures against the live extractor",
        description:
          "Scores whether extraction (with the pack's predicates + " +
          'extractionProfile active) still meets the pack’s own ' +
          'expectations. Runs up to MAX_EVAL_FIXTURES live LLM calls — ' +
          'throttled to 3 requests/min per credential.',
        scope: 'brain:admin',
        parameters: [
          pathParam('packId', 'The installed pack id.'),
          queryParam(
            'mode',
            "'union' (default) scores the shared union prompt; 'dedicated' " +
              'runs the pack-scoped dedicated prompt instead.',
            { type: 'string', enum: ['union', 'dedicated'] },
          ),
        ],
        responses: {
          '201': jsonResponse('The eval report.', ref('PackEvalReport')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
          '429': errorRef('TooManyRequests'),
        },
      }),
    },
  };
}

function documentsPaths(): Json {
  return {
    '/v1/ingest/document': {
      post: operation({
        operationId: 'ingestDocument',
        tag: 'Documents',
        summary: 'Ingest a normalized document',
        description:
          'Source → Indexer → Candidates → Brain: stores + chunks the ' +
          'text, runs the selected indexers, commits grounded candidates ' +
          'as facts. `mode: "async"` fans out per-indexer queue jobs ' +
          'instead (requires DOCUMENT_MULTI_INDEXER_ENABLED). Throttled ' +
          `to 10 requests/min per credential. ${FLAG_NOTE} ` +
          'Source: src/documents/documents-ingest.controller.ts.',
        scope: 'brain:write',
        requestBody: jsonBody(ref('IngestDocumentRequest')),
        responses: {
          '201': jsonResponse('Ingest outcome — shape follows the requested `mode`.', {
            oneOf: [ref('IngestDocumentSyncResponse'), ref('IngestDocumentAsyncResponse')],
          }),
          '400': errorRef('BadRequest'),
          '429': errorRef('TooManyRequests'),
          ...FLAG_GATED,
        },
      }),
    },
    '/v1/documents/{id}': {
      get: operation({
        operationId: 'getDocument',
        tag: 'Documents',
        summary: 'Read a document header and its indexer runs',
        description: `${FLAG_NOTE} ` + 'Source: src/documents/documents.controller.ts.',
        scope: 'brain:read',
        parameters: [
          pathParam('id', 'The document id.'),
          queryParam(
            'includeText',
            'Pass `1` to include the stored chunks. The raw text can carry ' +
              'any PII, so this additionally requires the `brain:read_pii` ' +
              'scope (403 otherwise).',
            { type: 'string', enum: ['1'] },
          ),
        ],
        responses: {
          '200': jsonResponse('The document.', ref('DocumentResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/documents/{id}/candidates': {
      get: operation({
        operationId: 'listDocumentCandidates',
        tag: 'Documents',
        summary: "The document's staged candidates (audit view)",
        description:
          'Every extraction candidate staged against the document, over ' +
          'all runs. `object`/`clause` of fact candidates whose predicate ' +
          'requires a scope the caller lacks are redacted; the row stays ' +
          `visible for the audit trail. ${FLAG_NOTE}`,
        scope: 'brain:read',
        parameters: [pathParam('id', 'The document id.')],
        responses: {
          '200': jsonResponse('The candidates.', ref('DocumentCandidatesResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
        },
      }),
      post: operation({
        operationId: 'submitDocumentCandidates',
        tag: 'Indexer work',
        summary: "Stage an external indexer's candidate batch",
        description:
          'A remote indexer that read a stored document submits its ' +
          'reading here. With `runId` + `claimToken` the submission ' +
          'fulfils a claimed work item; without them it opens its own run ' +
          '(claimless flow). Candidates are grounded against the stored ' +
          'text; the Brain commits once every run for the document is ' +
          'settled. Max 200 items per kind. Throttled to 10 requests/min ' +
          `per credential. ${FLAG_NOTE} ` +
          'Source: src/documents/external-candidates.controller.ts.',
        scope: 'indexer:write',
        parameters: [pathParam('id', 'The document id.')],
        requestBody: jsonBody(ref('SubmitCandidatesRequest')),
        responses: {
          '201': jsonResponse('Staged (and possibly committed).', ref('SubmitCandidatesResponse')),
          '400': errorRef('BadRequest'),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
          '429': errorRef('TooManyRequests'),
        },
      }),
    },
  };
}

function sourcesPaths(): Json {
  return {
    '/v1/sources': {
      get: operation({
        operationId: 'listSources',
        tag: 'Sources',
        summary: 'List source reputations (trust inputs)',
        description:
          'Catalogue of everything brain knows ABOUT its fact sources: the ' +
          'operator-declared identity (type, authLevel) joined with the ' +
          'learned agreement rates, one row per sourceKey. Public ' +
          'projection — operator annotations (owner/note) are served only ' +
          'on the brain:admin surface. `domain` additionally captures that ' +
          "domain's learned rate into `domainTrust` and makes `minSamples` " +
          'judge it (falling back to the global row). ' +
          'Source: src/sources/public-sources.controller.ts.',
        scope: 'brain:read',
        parameters: [
          queryParam('domain', 'Capture this domain’s learned rate per source (`domainTrust`).'),
          queryParam('type', 'Only sources declared with this type.', {
            type: 'string',
            enum: [...SOURCE_TYPES],
          }),
          queryParam(
            'minSamples',
            'Only sources whose learned rate rests on at least this many ' +
              'samples (domain-scoped row when `domain` is given, global ' +
              'row otherwise).',
            { type: 'integer' },
          ),
          queryParam('limit', 'Page size (default 50, max 200).', {
            type: 'integer',
          }),
          queryParam('offset', 'Page offset.', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('The reputation catalogue page.', ref('PublicSourcesListResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
        },
      }),
    },
    '/v1/sources/{sourceKey}': {
      get: operation({
        operationId: 'getSourceReputation',
        tag: 'Sources',
        summary: 'One source’s declared identity, trust scopes, and history',
        description:
          'Declared type/authLevel, every learned scope (global first, ' +
          'then domains alphabetically), and the reputation-over-time ' +
          'trail (newest first, capped at 50 rows). Public projection — ' +
          'owner/note are excluded. Same data the `get_source_reputation` ' +
          'MCP tool serves.',
        scope: 'brain:read',
        parameters: [
          pathParam('sourceKey', 'Source key, `vertical:recorder` (e.g. `rent:tenant_bot`).'),
        ],
        responses: {
          '200': jsonResponse('The source reputation detail.', ref('PublicSourceDetailResponse')),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
  };
}

/**
 * Raw-substrate driver v1 (docs/roadmap/raw-substrate-driver-2026-08.md).
 * Flag-gated with 404 (not 503): an absent surface is indistinguishable
 * from a disabled one by design.
 */
const DRIVER_404: Json = {
  ...AUTH_ERRORS,
  '404': errorRef('NotFound'),
};

function driverPaths(): Json {
  const episodeFilters = [
    queryParam('conversationId', 'Only turns of this conversation.'),
    queryParam('speaker', 'Only turns by this speaker.'),
    queryParam('since', 'ISO lower bound on occurredAt (inclusive).'),
    queryParam('until', 'ISO upper bound on occurredAt (exclusive).'),
  ];
  return {
    '/v1/episodes': {
      get: operation({
        operationId: 'listEpisodes',
        tag: 'Episodes',
        summary: 'Read the L0 episode substrate (keyset-paged)',
        description:
          'Verbatim pre-extraction dialogue turns in stable ' +
          '(occurredAt, id) order — the raw layer any consumer can build ' +
          'its own projection from. Callers without `brain:read_pii` see ' +
          'only episodes whose piiClass is empty. 404 until ' +
          'EPISODES_API_ENABLED=1. Source: ' +
          'src/episodes/episodes.controller.ts.',
        scope: 'brain:read',
        parameters: [
          ...episodeFilters,
          queryParam('limit', 'Page size (max 200, default 50).', {
            type: 'integer',
          }),
          queryParam('cursor', 'Opaque keyset cursor from the previous page (`nextCursor`).'),
        ],
        responses: {
          '200': jsonResponse('One page of episodes.', ref('EpisodesListResponse')),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/episodes/export': {
      get: operation({
        operationId: 'exportEpisodes',
        tag: 'Episodes',
        summary: 'Stream the substrate as NDJSON (replay/export)',
        description:
          'The same filtered stream as GET /v1/episodes, one episode per ' +
          'line, paged internally — bounded memory however large the ' +
          'tenant. 404 until EPISODES_API_ENABLED=1.',
        scope: 'brain:read',
        parameters: episodeFilters,
        responses: {
          '200': {
            description: 'NDJSON stream; each line is an Episode.',
            content: {
              'application/x-ndjson': { schema: ref('EpisodeWire') },
            },
          },
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/episodes/subscriptions': {
      post: operation({
        operationId: 'createEpisodeSubscription',
        tag: 'Episodes',
        summary: 'Register a new-episode webhook endpoint',
        description:
          'Registers an http(s) endpoint for `episodes_available` pushes ' +
          '(see the EpisodesAvailableEvent schema and the top-level ' +
          'webhooks section). The HMAC signing secret is returned exactly ' +
          'once. Pushes carry METADATA ONLY — bodies are pulled through ' +
          'GET /v1/episodes under the subscriber’s own scopes. ' +
          'Delivery is at-least-once. 404 until ' +
          'EPISODE_SUBSCRIPTIONS_ENABLED=1.',
        scope: 'brain:admin',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('CreateEpisodeSubscriptionRequest'),
            },
          },
        },
        responses: {
          '201': jsonResponse(
            'Registered; store the secret now.',
            ref('CreateEpisodeSubscriptionResponse'),
          ),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
      get: operation({
        operationId: 'listEpisodeSubscriptions',
        tag: 'Episodes',
        summary: 'List registered webhook endpoints',
        description: 'Secrets are never included. 404 until ' + 'EPISODE_SUBSCRIPTIONS_ENABLED=1.',
        scope: 'brain:read',
        responses: {
          '200': jsonResponse('Registered endpoints.', ref('EpisodeSubscriptionsListResponse')),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/episodes/subscriptions/{id}': {
      delete: operation({
        operationId: 'deleteEpisodeSubscription',
        tag: 'Episodes',
        summary: 'Delete a webhook endpoint',
        description: '404 until EPISODE_SUBSCRIPTIONS_ENABLED=1.',
        scope: 'brain:admin',
        parameters: [pathParam('id', 'The episode_subscription record id.')],
        responses: {
          '200': jsonResponse(
            'Whether a subscription was deleted.',
            ref('DeleteEpisodeSubscriptionResponse'),
          ),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/projections': {
      get: operation({
        operationId: 'listProjections',
        tag: 'Projections',
        summary: 'List derived surfaces and the live read pin',
        description:
          'Every derived world (facts@version, …) with its lifecycle ' +
          'status (building/built/live/residual/failed), watermark, ' +
          'builder identity and stats, plus the process-local read pin ' +
          '(RETRIEVAL_DERIVED_VERSION). A registry row promises a ' +
          'queryable world. 404 until PROJECTIONS_API_ENABLED=1. Source: ' +
          'src/admin/projections.controller.ts.',
        scope: 'brain:read',
        responses: {
          '200': jsonResponse('Derived worlds + read pin.', ref('ProjectionsListResponse')),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/projections/{name}/rebuild': {
      post: operation({
        operationId: 'rebuildProjection',
        tag: 'Projections',
        summary: 'Rebuild a derived surface (public verb)',
        description:
          'The public verb over the maintenance batch engine. v1 rebuilds ' +
          '`facts` (the session-window deriver): derives into the given ' +
          'version (a paid, operator-invoked batch), optionally flips the ' +
          'live read pin (`activate`). Rewriting the pinned world needs ' +
          '`force`. 404 until PROJECTIONS_API_ENABLED=1.',
        scope: 'brain:admin',
        parameters: [pathParam('name', 'The projection name (v1: `facts`).')],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: ref('RebuildProjectionRequest') },
          },
        },
        responses: {
          '200': jsonResponse('The batch result.', ref('RebuildProjectionResponse')),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
  };
}

/**
 * Memory read surface: fact-by-id + provenance ("show me why I
 * remember this"), belief reads (semantic_belief) and the rolling user
 * profile. Dark behind default-off flags with 404 (an absent surface
 * is indistinguishable from a disabled one).
 */
function memoryReadPaths(): Json {
  return {
    '/v1/facts/{id}': {
      get: operation({
        operationId: 'getFact',
        tag: 'Facts',
        summary: 'Read one fact by id',
        description:
          'The fact itself — what is remembered, where it came from ' +
          '(vertical/recorder/conversation), its validity instant and ' +
          'user scope. Every visibility fence (tenant, user scope, row ' +
          'policy) answers 404 — existence never leaks. 404 until ' +
          'FACTS_API_ENABLED=1. Source: src/facts/facts.controller.ts.',
        scope: 'brain:read',
        parameters: [pathParam('id', 'Fact record id (`knowledge_fact:…`).')],
        responses: {
          '200': jsonResponse('The fact.', ref('FactReadResponse')),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/facts/{id}/provenance': {
      get: operation({
        operationId: 'getFactProvenance',
        tag: 'Facts',
        summary: 'Read the grounding episodes behind a fact',
        description:
          'The verbatim source turns (`source.episodeIds`) the fact was ' +
          'derived or ingested from, chronological, text capped ' +
          'server-side. Callers without `brain:read_pii` never receive ' +
          'PII-classed episode text. Same 404 fences as ' +
          'GET /v1/facts/{id}. 404 until FACTS_API_ENABLED=1.',
        scope: 'brain:read',
        parameters: [pathParam('id', 'Fact record id (`knowledge_fact:…`).')],
        responses: {
          '200': jsonResponse('The grounding episodes.', ref('FactProvenanceResponse')),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/beliefs': {
      get: operation({
        operationId: 'listBeliefs',
        tag: 'Beliefs',
        summary: 'List beliefs by their free-text (subject, field) key',
        description:
          'Beliefs the brain currently holds (semantic_belief, promoted ' +
          'from enriched scenes), filtered by exact subject/field key, ' +
          'lifecycle status (default active) and user scope. A ' +
          'user-bound token is pinned to its own user (userId mismatch ' +
          'is 403); M2M keys may scope to any user or list tenant-wide. ' +
          'Page capped at 100 (default 25). 404 until ' +
          'BELIEFS_API_ENABLED=1. Source: ' +
          'src/beliefs/beliefs.controller.ts.',
        scope: 'brain:read',
        parameters: [
          queryParam('subject', 'Free-text subject key (exact match).'),
          queryParam('field', 'Free-text field key (exact match).'),
          queryParam(
            'userId',
            'End-user scope key. M2M keys may assert any user; ' +
              'user-bound tokens are pinned to their own.',
          ),
          queryParam('status', 'Lifecycle filter: `active` (default), `superseded`, `all`.'),
          queryParam('limit', 'Page size (default 25, max 100).', {
            type: 'integer',
          }),
        ],
        responses: {
          '200': jsonResponse('The visible beliefs.', ref('BeliefsListResponse')),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/beliefs/{id}': {
      get: operation({
        operationId: 'getBelief',
        tag: 'Beliefs',
        summary: 'Read one belief revision by id',
        description:
          'One semantic_belief revision as stored: the held value, its ' +
          'rendered statement, confidence, the supersede chain ' +
          '(revision/status/supersededBy/validFrom/validUntil), inline ' +
          'scene provenance (sourceSceneIds) and corroboration ' +
          'counters. Superseded revisions still resolve. Every ' +
          'visibility fence (tenant, fail-closed single-user scope) ' +
          'answers 404 — existence never leaks. 404 until ' +
          'BELIEFS_API_ENABLED=1. Source: ' +
          'src/beliefs/beliefs.controller.ts.',
        scope: 'brain:read',
        parameters: [pathParam('id', 'Belief record id (`semantic_belief:…`).')],
        responses: {
          '200': jsonResponse('The belief.', ref('BeliefReadResponse')),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/users/{userId}/profile': {
      get: operation({
        operationId: 'getUserProfile',
        tag: 'Users',
        summary: 'Rolling user profile (deterministic v1)',
        description:
          'Query-time assembly of what the platform knows about a user: ' +
          'active user-scoped facts grouped by aspect (persona-first), ' +
          'plus `profileText` shaped for direct prompt injection. ' +
          'Deterministic — no model calls. A user-bound token may only ' +
          'fetch its own profile (mismatch 403); M2M tokens any. 404 ' +
          'until USER_PROFILE_API_ENABLED=1. Source: ' +
          'src/users/user-profile.controller.ts.',
        scope: 'brain:read',
        parameters: [
          pathParam('userId', 'The user whose profile to assemble.'),
          queryParam('maxFacts', 'Global fact budget (default 60, max 200).', {
            type: 'integer',
          }),
          queryParam('lang', 'Soft locale filter (facts in this language or unmarked).'),
        ],
        responses: {
          '200': jsonResponse('The assembled profile.', ref('UserProfileResponse')),
          '400': errorRef('BadRequest'),
          ...DRIVER_404,
        },
      }),
    },
  };
}

/**
 * Raw-evidence read gateway (Brain v2.1 MM-3). The '/v1/episodes
 * 404-until-flag' precedent: every route (the unauthenticated redeem
 * included) answers a bare 404 while EVIDENCE_RAW_READ_ENABLED is off,
 * and every controller-side denial — cross-tenant, no grant, no
 * consent, PII-blocked, quarantined, bad/expired/revoked token — is the
 * SAME bare 404 (no existence oracle; outcomes differ only in the
 * content-free evidence_access audit table, migration 0125).
 */
function evidencePaths(): Json {
  const blobResponse: Json = {
    description:
      'The original bytes (Content-Type = the registered mediaType), ' +
      'with X-Content-Type-Options: nosniff, Cache-Control: no-store ' +
      'and Content-Disposition: attachment.',
    content: {
      'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
    },
  };
  const rawDescription =
    'Streams the asset’s original bytes after the full gate ladder: ' +
    'brain:read scope, ABAC action `rest.evidence.raw`, tenant fence ' +
    "(availability='hot', quarantine clean-or-absent), at least one " +
    'live ownership grant (a user-bound key needs the end user’s own), ' +
    'current pack modality consent declaring the raw-evidence ' +
    'capability, and the media-PII polarity (unclassified blocked, `[]` ' +
    'open, non-empty needs `brain:read_media`). Any denial is a bare ' +
    '404. 404 until EVIDENCE_RAW_READ_ENABLED=1. Source: ' +
    'src/evidence/evidence-read.controller.ts.';
  const mintDescription =
    'Same gate ladder as the raw stream; on pass answers a short-lived ' +
    'signed URL token (HMAC-SHA256, EVIDENCE_SIGNED_URL_SECRET, TTL ' +
    'EVIDENCE_SIGNED_URL_TTL_SECONDS, default 300 s) redeemable WITHOUT ' +
    'auth at /v1/evidence/redeem/{token}. 503 while the secret is not ' +
    'configured. 404 until EVIDENCE_RAW_READ_ENABLED=1.';
  return {
    '/v1/evidence/{assetId}/raw': {
      get: operation({
        operationId: 'streamEvidenceAsset',
        tag: 'Evidence',
        summary: 'Stream an evidence asset’s original bytes',
        description: rawDescription,
        scope: 'brain:read',
        parameters: [pathParam('assetId', 'evidence_asset record id.')],
        responses: { '200': blobResponse, ...DRIVER_404 },
      }),
    },
    '/v1/evidence/{assetId}/raw-url': {
      get: operation({
        operationId: 'mintEvidenceAssetUrl',
        tag: 'Evidence',
        summary: 'Mint a signed short-lived URL for an asset’s bytes',
        description: mintDescription,
        scope: 'brain:read',
        parameters: [pathParam('assetId', 'evidence_asset record id.')],
        responses: {
          '200': jsonResponse('The signed URL.', ref('EvidenceRawUrlResponse')),
          '503': errorRef('FeatureDisabled'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/evidence/fragments/{fragmentId}/raw': {
      get: operation({
        operationId: 'streamEvidenceFragment',
        tag: 'Evidence',
        summary: 'Stream a fragment’s evidence bytes (parent asset, v1)',
        description:
          'Fragment twin of the asset stream: v1 serves the WHOLE parent ' +
          'asset’s bytes (no locator cropping yet) under the STRICTEST ' +
          'union of the fragment’s and the asset’s piiClasses. ' +
          rawDescription,
        scope: 'brain:read',
        parameters: [pathParam('fragmentId', 'evidence_fragment record id.')],
        responses: { '200': blobResponse, ...DRIVER_404 },
      }),
    },
    '/v1/evidence/fragments/{fragmentId}/raw-url': {
      get: operation({
        operationId: 'mintEvidenceFragmentUrl',
        tag: 'Evidence',
        summary: 'Mint a signed short-lived URL for a fragment’s bytes',
        description:
          'Fragment twin of the asset mint (whole parent-asset bytes, ' +
          'strictest piiClasses union). ' +
          mintDescription,
        scope: 'brain:read',
        parameters: [pathParam('fragmentId', 'evidence_fragment record id.')],
        responses: {
          '200': jsonResponse('The signed URL.', ref('EvidenceRawUrlResponse')),
          '503': errorRef('FeatureDisabled'),
          ...DRIVER_404,
        },
      }),
    },
    '/v1/evidence/redeem/{token}': {
      get: {
        operationId: 'redeemEvidenceUrl',
        tags: ['Evidence'],
        summary: 'Redeem a signed raw-evidence URL (no auth)',
        description:
          'Unauthenticated by design — the token IS the capability. No ' +
          'ABAC/consent/PII re-run; fail-closed re-checks only: ' +
          'signature, expiry, the token’s own tenant, availability ' +
          "still 'hot', and at least one live grant (revocation " +
          'backstop). Bad, expired and revoked tokens all answer the ' +
          'same bare 404. 404 until EVIDENCE_RAW_READ_ENABLED=1.',
        parameters: [pathParam('token', 'The signed token from a raw-url mint.')],
        responses: { '200': blobResponse, '404': errorRef('NotFound') },
      },
    },
  };
}

function indexerWorkPaths(): Json {
  return {
    '/v1/indexer/work': {
      get: operation({
        operationId: 'listIndexerWork',
        tag: 'Indexer work',
        summary: 'Poll for pending external work items',
        description:
          'Pending indexer runs routed to this tenant’s installed ' +
          'external packs. Protocol: docs/indexer-protocol.md. ' +
          `${FLAG_NOTE} Source: src/documents/indexer-work.controller.ts.`,
        scope: 'indexer:write',
        parameters: [
          queryParam('packId', 'Only work for this external pack.'),
          queryParam('limit', 'Max items to return.', { type: 'integer' }),
        ],
        responses: {
          '200': jsonResponse('Claimable work items.', ref('IndexerWorkListResponse')),
          ...FLAG_GATED,
        },
      }),
    },
    '/v1/indexer/work/{runId}/claim': {
      post: operation({
        operationId: 'claimIndexerWork',
        tag: 'Indexer work',
        summary: 'Claim a pending work item',
        description:
          'Atomically transitions the run to claimed and returns the ' +
          'claimToken that fences all subsequent calls. Heartbeat within ' +
          `leaseSeconds or the claim is reaped as abandoned. ${FLAG_NOTE}`,
        scope: 'indexer:write',
        parameters: [pathParam('runId', 'The work item (indexer run) id.')],
        responses: {
          '201': jsonResponse('The claim.', ref('ClaimWorkResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
        },
      }),
    },
    '/v1/indexer/work/{runId}/heartbeat': {
      post: operation({
        operationId: 'heartbeatIndexerWork',
        tag: 'Indexer work',
        summary: 'Renew a claim lease',
        description: `Extends the lease of a claimed work item. ${FLAG_NOTE}`,
        scope: 'indexer:write',
        parameters: [pathParam('runId', 'The claimed work item id.')],
        requestBody: jsonBody(ref('HeartbeatWorkRequest')),
        responses: {
          '201': jsonResponse('The renewed lease.', ref('HeartbeatWorkResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
        },
      }),
    },
    '/v1/indexer/work/{runId}/content': {
      get: operation({
        operationId: 'getIndexerWorkContent',
        tag: 'Indexer work',
        summary: "Read the claimed document's stored content",
        description:
          'Serves the verbatim stored chunks of the claimed document — ' +
          'only for documents whose ingest routed to this tenant’s ' +
          `installed external packs. ${FLAG_NOTE}`,
        scope: 'indexer:write',
        parameters: [pathParam('runId', 'The claimed work item id.')],
        responses: {
          '200': jsonResponse('The document content.', ref('WorkContentResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
        },
      }),
    },
    '/v1/indexer/work/{runId}/fail': {
      post: operation({
        operationId: 'failIndexerWork',
        tag: 'Indexer work',
        summary: 'Release or permanently fail a claim',
        description:
          "Default RELEASES the item back to 'pending' (transient trouble, " +
          "shutdown mid-work); `permanent: true` marks the run 'failed' — " +
          `no longer offered. ${FLAG_NOTE}`,
        scope: 'indexer:write',
        parameters: [pathParam('runId', 'The claimed work item id.')],
        requestBody: jsonBody(ref('FailWorkRequest')),
        responses: {
          '201': jsonResponse('The outcome.', ref('FailWorkResponse')),
          ...FLAG_GATED,
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
        },
      }),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Document assembly.
 * ------------------------------------------------------------------ */

/** Recursively sort object keys so the emitted JSON is byte-deterministic. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Json).sort()) {
      out[key] = sortKeysDeep((value as Json)[key]);
    }
    return out;
  }
  return value;
}

function errorResponses(): Json {
  const err = (description: string): Json => jsonResponse(description, ref('ErrorResponse'));
  return {
    BadRequest: err('Validation failed.'),
    Unauthorized: err('Missing or unknown bearer key.'),
    Forbidden: err('The key lacks the required scope.'),
    NotFound: err('No such resource in this tenant.'),
    Conflict: err(
      'State conflict — e.g. a lost/mismatched claim token, an already ' +
        'claimed work item, or an immutable-version republish.',
    ),
    TooManyRequests: err('Per-credential throttle exceeded.'),
    FeatureDisabled: jsonResponse(
      'The document pipeline is dark (DOCUMENT_INGEST_ENABLED off).',
      ref('FeatureDisabledResponse'),
    ),
    BadGateway: err('The billing service rejected the request.'),
    BillingUnavailable: err(
      'The billing service is unreachable — paid-pack entitlements ' +
        'cannot be verified (fail-closed). Retry shortly.',
    ),
  };
}

export function buildOpenApiDocument(): Json {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  };

  const document: Json = {
    openapi: '3.1.0',
    info: {
      title: 'INITE Brain — Platform API',
      version: pkg.version,
      summary:
        'The community-facing platform surface: Domain Pack registry, ' +
        'tenant pack admin, document ingest, the external-indexer ' +
        'work protocol, and source reputation reads.',
      description:
        'Generated from the zod wire contracts (`pnpm openapi:build` — ' +
        'scripts/build-openapi.ts); do not edit by hand. The admin/ops ' +
        'surface (jobs, leases, policy, stats, maintenance) is documented ' +
        'in docs/api.md instead. Scopes are plain bearer-key grants, not ' +
        'OAuth flows — each operation states its required scope.',
      license: {
        name: 'AGPL-3.0-or-later',
        identifier: 'AGPL-3.0-or-later',
      },
    },
    servers: [
      {
        url: 'https://brain.inite.ai',
        description:
          'Hosted instance (placeholder — self-hosted deployments serve ' +
          'the same paths on their own origin).',
      },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      {
        name: 'Registry',
        description:
          'Discovery reads over the global Domain Pack registry ' + '(shared across all tenants).',
      },
      {
        name: 'Registry publishing',
        description:
          'Publisher-facing writes to the global registry ' + '(scope `registry:publish`).',
      },
      {
        name: 'Marketplace',
        description:
          'Featured curation (scope `registry:curate`), pack pricing + ' +
          'publisher profiles (scope `registry:publish`) and the ' +
          'paid-pack checkout (scope `brain:admin`). State is ' +
          'instance-local — never part of the signed manifest, never ' +
          'mirrored.',
      },
      {
        name: 'Domain Packs',
        description:
          'Tenant-level pack management: install, list, eval, uninstall ' +
          '(scope `brain:admin`).',
      },
      {
        name: 'Documents',
        description:
          'The document pipeline: Source → Indexer → Candidates → Brain. ' +
          'Dark behind DOCUMENT_INGEST_ENABLED (default off).',
      },
      {
        name: 'Indexer work',
        description:
          'The external-indexer protocol (scope `indexer:write`): poll → ' +
          'claim → read content → submit candidates / fail. ' +
          'See docs/indexer-protocol.md.',
      },
      {
        name: 'Sources',
        description:
          'Read-only trust inputs (scope `brain:read`): declared source ' +
          'identity ⋈ learned reputation. Public projection — operator ' +
          'annotations (owner/note) stay on the admin surface.',
      },
      {
        name: 'Episodes',
        description:
          'The raw-substrate driver: verbatim pre-extraction dialogue ' +
          'turns (L0) as a contract — keyset reads, NDJSON export, and ' +
          'signed new-episode webhooks — so any consumer can build its ' +
          'own projection without touching our database. Flags: ' +
          'EPISODES_API_ENABLED / EPISODE_SUBSCRIPTIONS_ENABLED ' +
          '(off → 404).',
      },
      {
        name: 'Projections',
        description:
          'Derived surfaces as first-class records: lifecycle status, ' +
          'watermark, builder identity, and rebuild as the public verb. ' +
          'Flag: PROJECTIONS_API_ENABLED (off → 404).',
      },
      {
        name: 'Facts',
        description:
          'Fact-level reads: one fact by id and its grounding episodes — ' +
          'provenance-first memory ("show me why I remember this"). ' +
          'Flag: FACTS_API_ENABLED (off → 404); fact retraction stays ' +
          'flag-independent.',
      },
      {
        name: 'Beliefs',
        description:
          'Belief-level reads over the semantic_belief substrate: what ' +
          'the brain currently holds about a free-text (subject, field) ' +
          'key, with its supersede chain and inline scene provenance. ' +
          'Read-only — the scene promotion pass is the only writer. ' +
          'Flag: BELIEFS_API_ENABLED (off → 404).',
      },
      {
        name: 'Evidence',
        description:
          'The raw-evidence read gateway: original observation bytes ' +
          'back out — direct stream, signed short-lived URLs, fragment ' +
          'twins — behind the full deny-overrides gate ladder (scope, ' +
          'ABAC, tenant/availability/quarantine, ownership grants, pack ' +
          'modality consent, media-PII polarity), every attempt audited ' +
          'content-free. Flag: EVIDENCE_RAW_READ_ENABLED (off → 404).',
      },
      {
        name: 'Users',
        description:
          'Per-user surfaces: the rolling user profile assembled from ' +
          'user-scoped memory. Flag: USER_PROFILE_API_ENABLED ' +
          '(off → 404).',
      },
    ],
    paths: {
      ...registryPaths(),
      ...marketplacePaths(),
      ...packsAdminPaths(),
      ...documentsPaths(),
      ...indexerWorkPaths(),
      ...sourcesPaths(),
      ...driverPaths(),
      ...memoryReadPaths(),
      ...evidencePaths(),
    },
    webhooks: {
      episodesAvailable: {
        post: {
          operationId: 'episodesAvailableWebhook',
          tags: ['Episodes'],
          summary: 'New-episode push (outbound webhook)',
          description:
            'Brain POSTs this to every registered subscription endpoint ' +
            'when fresh episodes land. Metadata only — never episode ' +
            'text. Signed `X-Brain-Signature: sha256=<hex hmac>` over ' +
            'the raw JSON body with the per-subscription secret. ' +
            'Delivery is at-least-once (dedupe on episode ids); the ' +
            'watermark advances only after a 2xx.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('EpisodesAvailableEvent') },
            },
          },
          responses: {
            '200': { description: 'Acknowledged; the watermark advances.' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API key (`Authorization: Bearer <key>`); its SHA-256 must be ' +
            'registered in BRAIN_API_KEYS. Keys carry scopes ' +
            '(`brain:read`, `brain:write`, `brain:admin`, `brain:read_pii`, ' +
            '`registry:publish`, `registry:curate`, `indexer:write`) — ' +
            'each operation states the scope it requires. Not an OAuth flow.',
        },
      },
      schemas: generateComponentSchemas(),
      responses: errorResponses(),
    },
  };

  return sortKeysDeep(document) as Json;
}

/**
 * Where the document is written.
 *
 * Two copies, because brain.inite.ai/openapi.json is a URL three things
 * already promise — the landing's footer on every page, its llms.txt, and
 * .well-known/agent-actions as the API description — and none of them ever
 * resolved. The reason was routing, not authorship: deploy-brain.yml claimed
 * `Path(/openapi.json)` for the backend at priority 200, and the backend has
 * no route for it, no Swagger module, and no copy of this file in its image
 * (its Dockerfile ships src, dist and package.json). The request reached the
 * one container that could not answer it.
 *
 * The document is a committed static artifact, so the path now falls through
 * to the landing's catch-all and is served from its public/ next to
 * /install.sh and /skills.tar.gz. It has to be a second write rather than a
 * reference: the landing's Docker build copies only from inside
 * brain-landing/, so a route reaching up to ../../docs would work locally and
 * 404 in production.
 *
 * The copies cannot drift: one run of this script produces both, and
 * test/openapi-doc.unit-spec.ts asserts both against a fresh build.
 */
const OUT_PATHS = [
  join(__dirname, '..', 'docs', 'openapi.json'),
  join(__dirname, '..', 'brain-landing', 'public', 'openapi.json'),
];

function main(): void {
  const document = buildOpenApiDocument();
  const body = JSON.stringify(document, null, 2) + '\n';
  for (const outPath of OUT_PATHS) writeFileSync(outPath, body, 'utf8');
  const paths = Object.keys(document.paths as Json).length;
  const schemas = Object.keys((document.components as Json).schemas as Json).length;
  process.stdout.write(`wrote ${OUT_PATHS.length} copies (${paths} paths, ${schemas} schemas)\n`);
}

if (require.main === module) main();
