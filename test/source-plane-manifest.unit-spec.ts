/**
 * The manifest's `sources` section (source plane, W0): structural
 * validation (validate-sources.ts) and install consent
 * (sources-consent.ts) — the mcpTools mold applied to where a pack
 * reads from.
 */
import {
  CODE_MEMORY_PACK,
  DomainPackError,
  sourcesChecksum,
  sourcesConsentRequired,
  validatePack,
  wantsInstallSecret,
  type DomainPackManifest,
} from '../src/ai/domain-packs';

const base = (sources: unknown): DomainPackManifest =>
  ({
    id: 'wiki_pack',
    version: '1.0.0',
    description: 'A pack that reads a wiki.',
    predicates: [
      {
        localId: 'page_topic',
        displayLabel: 'page topic',
        description: 'TYPE subject is a page; value is its topic',
        datatype: 'string',
        semantics: 'append_only',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
    ],
    sources,
  }) as unknown as DomainPackManifest;

const mcpHttp = {
  id: 'wiki',
  kind: 'mcp',
  transport: 'http',
  url: 'https://mcp.example.com/wiki',
  auth: 'install_secret',
  shape: 'document',
};

describe('validatePack — sources section', () => {
  it('accepts every kind with its required fields', () => {
    expect(() =>
      validatePack(
        base([
          mcpHttp,
          { id: 'vault', kind: 'mcp', transport: 'stdio', command: 'npx obsidian-mcp', shape: 'document' },
          { id: 'folder', kind: 'native', connector: 'fs', shape: 'binary' },
          { id: 'push', kind: 'external', shape: 'structure', defaults: { schedule: '1h', deletePolicy: 'close' } },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ['empty array', []],
    ['not an array', { id: 'x' }],
    ['bad id', [{ ...mcpHttp, id: 'Wiki-1' }]],
    ['duplicate id', [mcpHttp, { ...mcpHttp }]],
    ['unknown kind', [{ ...mcpHttp, kind: 'rest' }]],
    ['unknown shape', [{ ...mcpHttp, shape: 'table' }]],
    ['http without url', [{ ...mcpHttp, url: 'not a url' }]],
    ['http bad auth', [{ ...mcpHttp, auth: 'basic' }]],
    ['stdio without command', [{ id: 'v', kind: 'mcp', transport: 'stdio', shape: 'document' }]],
    ['stdio too many args', [{ id: 'v', kind: 'mcp', transport: 'stdio', command: 'x', args: new Array(17).fill('a'), shape: 'document' }]],
    ['unknown transport', [{ id: 'v', kind: 'mcp', transport: 'ws', shape: 'document' }]],
    ['native bad connector name', [{ id: 'f', kind: 'native', connector: 'FS', shape: 'document' }]],
    ['bad default schedule', [{ ...mcpHttp, defaults: { schedule: '5m' } }]],
    ['bad default policy', [{ ...mcpHttp, defaults: { contentPolicy: 'all' } }]],
    ['title too long', [{ ...mcpHttp, title: 'x'.repeat(81) }]],
    ['too many', new Array(9).fill(0).map((_, i) => ({ ...mcpHttp, id: `s${i}` }))],
  ])('rejects: %s', (_label, sources) => {
    expect(() => validatePack(base(sources))).toThrow(DomainPackError);
  });
});

describe('sources consent', () => {
  it('no section ⇒ no checksum, no consent needed', () => {
    const m = base(undefined);
    expect(sourcesChecksum(m)).toBeNull();
    expect(
      sourcesConsentRequired({ manifest: m, acceptSources: undefined, priorAccepted: false, priorChecksum: null }),
    ).toBeNull();
  });

  it('a declared section needs the flag, names what it declares, and a prior identical consent carries over', () => {
    const m = base([mcpHttp, { id: 'folder', kind: 'native', connector: 'fs', shape: 'binary' }]);
    const checksum = sourcesChecksum(m)!;
    const refused = sourcesConsentRequired({
      manifest: m,
      acceptSources: undefined,
      priorAccepted: false,
      priorChecksum: null,
    });
    expect(refused).toContain('2 source(s)');
    expect(refused).toContain('https://mcp.example.com/wiki');
    expect(refused).toContain('native "folder" (fs, binary)');
    expect(refused).toContain('acceptSources: true');
    expect(
      sourcesConsentRequired({ manifest: m, acceptSources: true, priorAccepted: false, priorChecksum: null }),
    ).toBeNull();
    expect(
      sourcesConsentRequired({ manifest: m, acceptSources: undefined, priorAccepted: true, priorChecksum: checksum }),
    ).toBeNull();
    // A changed section re-requires the flag.
    expect(
      sourcesConsentRequired({ manifest: m, acceptSources: undefined, priorAccepted: true, priorChecksum: 'stale' }),
    ).not.toBeNull();
  });

  it('an install_secret MCP source asks for the per-install secret', () => {
    expect(wantsInstallSecret(base([mcpHttp]))).toBe(true);
    expect(wantsInstallSecret(base([{ ...mcpHttp, auth: 'oauth' }]))).toBe(false);
    expect(wantsInstallSecret(base(undefined))).toBe(false);
  });

  it('code_memory is the first source pack — one external structure source', () => {
    expect(CODE_MEMORY_PACK.sources).toEqual([
      expect.objectContaining({ id: 'repository', kind: 'external', shape: 'structure' }),
    ]);
    expect(() => validatePack(CODE_MEMORY_PACK)).not.toThrow();
  });
});
