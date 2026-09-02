/**
 * Drift gate for docs/openapi.json — the committed OpenAPI 3.1 document
 * for the platform surface. Re-builds the document from the zod
 * contracts (scripts/build-openapi.ts) and asserts it deep-equals the
 * committed artifact: any contract or path change without a
 * `pnpm openapi:build` fails here. Pure — no Nest app boots.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildOpenApiDocument } from '../scripts/build-openapi';

type Json = Record<string, unknown>;

const built = buildOpenApiDocument();
const committed = JSON.parse(
  readFileSync(join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'),
) as Json;

/** Every platform path+method the spec promises to document. */
const PLATFORM_OPERATIONS: Array<[string, string]> = [
  ['/v1/registry/packs', 'get'],
  ['/v1/registry/packs/{packId}', 'get'],
  ['/v1/registry/packs/{packId}/{version}', 'get'],
  ['/v1/admin/registry/packs', 'post'],
  ['/v1/admin/registry/packs/{packId}/{version}/yank', 'post'],
  ['/v1/admin/registry/packs/{packId}/{version}/unyank', 'post'],
  ['/v1/registry/publishers/{publisher}', 'get'],
  ['/v1/admin/registry/packs/{packId}/pricing', 'put'],
  ['/v1/admin/registry/packs/{packId}/pricing', 'delete'],
  ['/v1/admin/registry/packs/{packId}/feature', 'post'],
  ['/v1/admin/registry/packs/{packId}/unfeature', 'post'],
  ['/v1/admin/registry/publishers/{publisher}', 'put'],
  ['/v1/admin/registry/packs/{packId}/checkout', 'post'],
  ['/v1/admin/packs', 'get'],
  ['/v1/admin/packs', 'post'],
  ['/v1/admin/packs/from-registry', 'post'],
  ['/v1/admin/packs/{packId}', 'delete'],
  ['/v1/admin/packs/{packId}/eval', 'post'],
  ['/v1/facts/{id}', 'get'],
  ['/v1/facts/{id}/provenance', 'get'],
  ['/v1/beliefs', 'get'],
  ['/v1/beliefs/{id}', 'get'],
  ['/v1/users/{userId}/profile', 'get'],
  ['/v1/ingest/document', 'post'],
  ['/v1/documents/{id}', 'get'],
  ['/v1/documents/{id}/candidates', 'get'],
  ['/v1/documents/{id}/candidates', 'post'],
  ['/v1/indexer/work', 'get'],
  ['/v1/indexer/work/{runId}/claim', 'post'],
  ['/v1/indexer/work/{runId}/heartbeat', 'post'],
  ['/v1/indexer/work/{runId}/content', 'get'],
  ['/v1/indexer/work/{runId}/fail', 'post'],
  ['/v1/sources', 'get'],
  ['/v1/sources/{sourceKey}', 'get'],
  // raw-substrate driver v1 (episodes read + subscriptions + projections)
  ['/v1/episodes', 'get'],
  ['/v1/episodes/export', 'get'],
  ['/v1/episodes/subscriptions', 'post'],
  ['/v1/episodes/subscriptions', 'get'],
  ['/v1/episodes/subscriptions/{id}', 'delete'],
  ['/v1/projections', 'get'],
  ['/v1/projections/{name}/rebuild', 'post'],
];

describe('docs/openapi.json', () => {
  it('is an OpenAPI 3.1 document with the package version', () => {
    expect(built.openapi).toBe('3.1.0');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect((built.info as Json).version).toBe(pkg.version);
  });

  it('matches the committed artifact (regenerate: pnpm openapi:build)', () => {
    // info.version is compared normalized: the built document reads
    // package.json at test time, and a release-please version bump
    // must not fail main CI until someone regenerates — every OTHER
    // byte still gates strictly. (The committed version catches up on
    // the next `pnpm openapi:build`.)
    const stripVersion = (doc: Json): Json => ({
      ...doc,
      info: { ...(doc.info as Json), version: 'NORMALIZED' },
    });
    expect(stripVersion(committed)).toEqual(stripVersion(built));
  });

  // The landing serves a second copy at brain.inite.ai/openapi.json — the URL
  // its own footer, llms.txt and .well-known/agent-actions have always pointed
  // at, and which 404'd because deploy-brain.yml routed the path to this
  // service, which has no route for it. It has to be a copy rather than a
  // reference: brain-landing's Docker build copies only from inside
  // brain-landing/, so a route reaching up to ../../docs would work locally
  // and fail in production. Something then has to notice when the two stop
  // agreeing, and this is that something.
  it('is published byte-identically to brain-landing/public', () => {
    const published = readFileSync(
      join(__dirname, '..', 'brain-landing', 'public', 'openapi.json'),
      'utf8',
    );
    expect(published).toBe(readFileSync(join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'));
  });

  it.each(PLATFORM_OPERATIONS)('documents %s %s with operationId and responses', (path, method) => {
    const pathItem = (built.paths as Json)[path] as Json | undefined;
    expect(pathItem).toBeDefined();
    const op = pathItem?.[method] as Json | undefined;
    expect(op).toBeDefined();
    expect(typeof op?.operationId).toBe('string');
    expect((op?.operationId as string).length).toBeGreaterThan(0);
    const responses = op?.responses as Json;
    expect(Object.keys(responses).length).toBeGreaterThanOrEqual(1);
  });

  it('documents no paths beyond the platform surface', () => {
    const documented = Object.keys(built.paths as Json).sort();
    const expected = [...new Set(PLATFORM_OPERATIONS.map(([p]) => p))].sort();
    expect(documented).toEqual(expected);
  });

  it('every operation states its required scope and is bearer-secured', () => {
    expect(built.security).toEqual([{ bearerAuth: [] }]);
    for (const [path, method] of PLATFORM_OPERATIONS) {
      const op = ((built.paths as Json)[path] as Json)[method] as Json;
      expect(op.description).toMatch(/Required scope: `[a-z_]+:[a-z_]+`/);
    }
  });

  it('every $ref in the document resolves', () => {
    const refs = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Json)) {
          if (k === '$ref' && typeof v === 'string') refs.add(v);
          else collect(v);
        }
      }
    };
    collect(built);
    expect(refs.size).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r).toMatch(/^#\//);
      let cursor: unknown = built;
      for (const part of r.slice(2).split('/')) {
        cursor = (cursor as Json | undefined)?.[part];
      }
      expect(cursor).toBeDefined();
    }
  });
});
