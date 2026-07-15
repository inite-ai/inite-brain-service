#!/usr/bin/env -S npx ts-node -T
/**
 * build-openapi — assemble the OpenAPI 3.1 document for the PLATFORM
 * surface (the community-facing API: pack registry, pack admin, document
 * ingest/read, external-indexer candidates + work discovery). The
 * admin/ops surface (jobs, leases, policy, stats, maintenance) is out of
 * scope on purpose.
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
      'Answered by every document-pipeline route while ' +
      'DOCUMENT_INGEST_ENABLED is off.',
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
          'All published versions of a pack, newest first, including ' +
          'yanked ones (flagged).',
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
          '200': jsonResponse(
            'The resolved manifest.',
            ref('RegistryManifestResponse'),
          ),
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
          'installed content is exactly what the registry served.',
        scope: 'brain:admin',
        requestBody: jsonBody(ref('InstallFromRegistryRequest')),
        responses: {
          '201': jsonResponse('Installed.', ref('InstallPackResponse')),
          '400': errorRef('BadRequest'),
          ...AUTH_ERRORS,
          '404': errorRef('NotFound'),
        },
      }),
    },
    '/v1/admin/packs/{packId}': {
      delete: operation({
        operationId: 'uninstallDomainPack',
        tag: 'Domain Packs',
        summary: 'Uninstall a pack from this tenant',
        description:
          "Deprecates the pack's predicates; facts extracted with them " +
          'survive.',
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
            oneOf: [
              ref('IngestDocumentSyncResponse'),
              ref('IngestDocumentAsyncResponse'),
            ],
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
        description:
          `${FLAG_NOTE} ` +
          'Source: src/documents/documents.controller.ts.',
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
  const err = (description: string): Json =>
    jsonResponse(description, ref('ErrorResponse'));
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
  };
}

export function buildOpenApiDocument(): Json {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string };

  const document: Json = {
    openapi: '3.1.0',
    info: {
      title: 'INITE Brain — Platform API',
      version: pkg.version,
      summary:
        'The community-facing platform surface: Domain Pack registry, ' +
        'tenant pack admin, document ingest, and the external-indexer ' +
        'work protocol.',
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
          'Discovery reads over the global Domain Pack registry ' +
          '(shared across all tenants).',
      },
      {
        name: 'Registry publishing',
        description:
          'Publisher-facing writes to the global registry ' +
          '(scope `registry:publish`).',
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
    ],
    paths: {
      ...registryPaths(),
      ...packsAdminPaths(),
      ...documentsPaths(),
      ...indexerWorkPaths(),
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
            '`registry:publish`, `indexer:write`) — each operation states ' +
            'the scope it requires. Not an OAuth flow.',
        },
      },
      schemas: generateComponentSchemas(),
      responses: errorResponses(),
    },
  };

  return sortKeysDeep(document) as Json;
}

function main(): void {
  const outPath = join(__dirname, '..', 'docs', 'openapi.json');
  const document = buildOpenApiDocument();
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
  const paths = Object.keys(document.paths as Json).length;
  const schemas = Object.keys(
    (document.components as Json).schemas as Json,
  ).length;
  process.stdout.write(
    `wrote docs/openapi.json (${paths} paths, ${schemas} schemas)\n`,
  );
}

if (require.main === module) main();
