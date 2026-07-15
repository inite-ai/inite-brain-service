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
  ['/v1/admin/packs', 'get'],
  ['/v1/admin/packs', 'post'],
  ['/v1/admin/packs/from-registry', 'post'],
  ['/v1/admin/packs/{packId}', 'delete'],
  ['/v1/admin/packs/{packId}/eval', 'post'],
  ['/v1/ingest/document', 'post'],
  ['/v1/documents/{id}', 'get'],
  ['/v1/documents/{id}/candidates', 'get'],
  ['/v1/documents/{id}/candidates', 'post'],
  ['/v1/indexer/work', 'get'],
  ['/v1/indexer/work/{runId}/claim', 'post'],
  ['/v1/indexer/work/{runId}/heartbeat', 'post'],
  ['/v1/indexer/work/{runId}/content', 'get'],
  ['/v1/indexer/work/{runId}/fail', 'post'],
];

describe('docs/openapi.json', () => {
  it('is an OpenAPI 3.1 document with the package version', () => {
    expect(built.openapi).toBe('3.1.0');
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect((built.info as Json).version).toBe(pkg.version);
  });

  it('matches the committed artifact (regenerate: pnpm openapi:build)', () => {
    expect(committed).toEqual(built);
  });

  it.each(PLATFORM_OPERATIONS)(
    'documents %s %s with operationId and responses',
    (path, method) => {
      const pathItem = (built.paths as Json)[path] as Json | undefined;
      expect(pathItem).toBeDefined();
      const op = pathItem?.[method] as Json | undefined;
      expect(op).toBeDefined();
      expect(typeof op?.operationId).toBe('string');
      expect((op?.operationId as string).length).toBeGreaterThan(0);
      const responses = op?.responses as Json;
      expect(Object.keys(responses).length).toBeGreaterThanOrEqual(1);
    },
  );

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
