import { ReadPinService, derivedVersionFence } from '../src/episodes/read-pin.service';
import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { ProjectionRegistryService } from '../src/episodes/projection-registry.service';

/**
 * Audit W2 (engine-architecture-audit-2026-08.md #9): the derived-world
 * pin was `process.env.RETRIEVAL_DERIVED_VERSION`, mutated at runtime by
 * a per-tenant activation — cross-tenant blast radius, invisible to
 * other pods, rolled back on restart, and contradicted by the registry
 * row that claimed to be live. The registry is now the pin.
 */
function registryWith(
  rows: Array<{ name: string; version: string; status: string }>,
): ProjectionRegistryService {
  return {
    list: async () => rows,
  } as unknown as ProjectionRegistryService;
}

describe('ReadPinService', () => {
  const saved = process.env.RETRIEVAL_DERIVED_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = saved;
  });

  it('the registry live row wins over the env bootstrap', async () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const svc = new ReadPinService(
      registryWith([
        { name: 'facts', version: 'wd-live', status: 'live' },
        { name: 'facts', version: 'wd-old', status: 'residual' },
      ]),
    );
    expect(await svc.resolve('co_x')).toBe('wd-live');
  });

  it('no live row → the env bootstrap default (eval runners pin this way)', async () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const svc = new ReadPinService(
      registryWith([{ name: 'facts', version: 'wd-old', status: 'residual' }]),
    );
    expect(await svc.resolve('co_x')).toBe('env-world');
  });

  it('no registry and no env → legacy namespace (null)', async () => {
    delete process.env.RETRIEVAL_DERIVED_VERSION;
    expect(await new ReadPinService().resolve('co_x')).toBeNull();
  });

  it('a registry failure degrades to the bootstrap, never empties memory', async () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const broken = {
      list: async () => {
        throw new Error('db down');
      },
    } as unknown as ProjectionRegistryService;
    expect(await new ReadPinService(broken).resolve('co_x')).toBe('env-world');
  });

  it('resolves per TENANT — one tenant cannot repoint another', async () => {
    const registry = {
      list: async (companyId: string) =>
        companyId === 'co_a'
          ? [{ name: 'facts', version: 'world-a', status: 'live' }]
          : [{ name: 'facts', version: 'world-b', status: 'live' }],
    } as unknown as ProjectionRegistryService;
    const svc = new ReadPinService(registry);
    expect(await svc.resolve('co_a')).toBe('world-a');
    expect(await svc.resolve('co_b')).toBe('world-b');
  });

  it('caches, and invalidate makes an activation visible at once', async () => {
    let version = 'v1';
    let calls = 0;
    const registry = {
      list: async () => {
        calls += 1;
        return [{ name: 'facts', version, status: 'live' }];
      },
    } as unknown as ProjectionRegistryService;
    const svc = new ReadPinService(registry);
    expect(await svc.resolve('co_x')).toBe('v1');
    expect(await svc.resolve('co_x')).toBe('v1');
    expect(calls).toBe(1); // second read served from cache
    version = 'v2';
    expect(await svc.resolve('co_x')).toBe('v1'); // still cached
    svc.invalidate('co_x');
    expect(await svc.resolve('co_x')).toBe('v2');
  });
});

describe('buildBaseWhere honours the resolved pin', () => {
  const saved = process.env.RETRIEVAL_DERIVED_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = saved;
  });

  const base = {
    dto: {} as never,
    asOf: null,
    includeRetracted: false,
    includeContested: false,
  };

  it('an explicit version pins that world regardless of env', () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const { sql, params } = buildBaseWhere({
      ...base,
      derivedVersion: 'tenant-world',
    });
    expect(params.derivedVersion).toBe('tenant-world');
    expect(sql).toContain('derivedVersion = $derivedVersion');
  });

  it('an explicit null pins the legacy namespace even when env is set', () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const { sql, params } = buildBaseWhere({ ...base, derivedVersion: null });
    expect(sql).toContain('derivedVersion IS NONE');
    expect(params.derivedVersion).toBeUndefined();
  });

  it('undefined (unresolved caller) falls back to the env bootstrap', () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const { params } = buildBaseWhere(base);
    expect(params.derivedVersion).toBe('env-world');
  });
});

describe('multiworld READ union (§10 — RETRIEVAL_DERIVED_VERSIONS)', () => {
  const savedSingle = process.env.RETRIEVAL_DERIVED_VERSION;
  const savedUnion = process.env.RETRIEVAL_DERIVED_VERSIONS;
  afterEach(() => {
    if (savedSingle === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = savedSingle;
    if (savedUnion === undefined) delete process.env.RETRIEVAL_DERIVED_VERSIONS;
    else process.env.RETRIEVAL_DERIVED_VERSIONS = savedUnion;
  });

  it('bootstrapUnion parses, trims, dedupes; unset/blank → null', () => {
    delete process.env.RETRIEVAL_DERIVED_VERSIONS;
    expect(ReadPinService.bootstrapUnion()).toBeNull();
    process.env.RETRIEVAL_DERIVED_VERSIONS = '  ';
    expect(ReadPinService.bootstrapUnion()).toBeNull();
    process.env.RETRIEVAL_DERIVED_VERSIONS = ' wd-a, wd-b ,wd-a,, ';
    expect(ReadPinService.bootstrapUnion()).toEqual(['wd-a', 'wd-b']);
  });

  it('resolveRead unions the tenant world in — never displaces it', async () => {
    process.env.RETRIEVAL_DERIVED_VERSIONS = 'ssa-v1';
    const svc = new ReadPinService(
      registryWith([{ name: 'facts', version: 'wd-live', status: 'live' }]),
    );
    expect(await svc.resolveRead('co_x')).toEqual(['ssa-v1', 'wd-live']);
  });

  it('a one-world union that IS the tenant world collapses to the single pin', async () => {
    process.env.RETRIEVAL_DERIVED_VERSIONS = 'wd-live';
    const svc = new ReadPinService(
      registryWith([{ name: 'facts', version: 'wd-live', status: 'live' }]),
    );
    expect(await svc.resolveRead('co_x')).toBe('wd-live');
  });

  it('no union configured → resolveRead is exactly resolve()', async () => {
    delete process.env.RETRIEVAL_DERIVED_VERSIONS;
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    const svc = new ReadPinService();
    expect(await svc.resolveRead('co_x')).toBe('env-world');
  });

  it('derivedVersionFence: union → INSIDE, singleton collapses, empty → IS NONE', () => {
    expect(derivedVersionFence(['wd-a', 'wd-b'])).toEqual({
      clause: 'AND derivedVersion INSIDE $derivedVersions',
      params: { derivedVersions: ['wd-a', 'wd-b'] },
    });
    expect(derivedVersionFence(['wd-a'])).toEqual({
      clause: 'AND derivedVersion = $derivedVersion',
      params: { derivedVersion: 'wd-a' },
    });
    expect(derivedVersionFence([])).toEqual({
      clause: 'AND derivedVersion IS NONE',
      params: {},
    });
  });

  it('buildBaseWhere serves a union pin through INSIDE', () => {
    const { sql, params } = buildBaseWhere({
      dto: {} as never,
      asOf: null,
      includeRetracted: false,
      includeContested: false,
      derivedVersion: ['wd-a', 'wd-b'],
    });
    expect(sql).toContain('derivedVersion INSIDE $derivedVersions');
    expect(params.derivedVersions).toEqual(['wd-a', 'wd-b']);
  });

  it('an unresolved caller inherits the env union bootstrap', () => {
    process.env.RETRIEVAL_DERIVED_VERSION = 'env-world';
    process.env.RETRIEVAL_DERIVED_VERSIONS = 'ssa-v1';
    const { sql, params } = buildBaseWhere({
      dto: {} as never,
      asOf: null,
      includeRetracted: false,
      includeContested: false,
    });
    expect(sql).toContain('derivedVersion INSIDE $derivedVersions');
    expect(params.derivedVersions).toEqual(['ssa-v1', 'env-world']);
  });
});
