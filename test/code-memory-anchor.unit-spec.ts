/**
 * Code-memory Phase 2 — symbol anchoring: TS symbol resolver, anchor-id format,
 * grounding refiner, drift validation + re-anchor. All pure / offline.
 */
import {
  enclosingSymbol,
  listSymbols,
  symbolExists,
} from '../src/code-memory/anchor/ts-symbol-resolver';
import {
  parseAnchor,
  symbolAnchorId,
  isSymbolAnchor,
} from '../src/code-memory/anchor/symbol-id';
import {
  makeSymbolAnchorRefiner,
  validateAnchor,
  reanchor,
} from '../src/code-memory/anchor/refine';
import type { DecisionCandidate } from '../src/code-memory/capture/types';

const SRC = `import { X } from './x';

export class FactResolverService {
  private readonly lock = 1;

  constructor(private readonly db: X) {}

  async resolve(id: string): Promise<number> {
    const y = id.length;
    return y;
  }

  private cfgNum(key: string): number {
    return 0;
  }
}

export function helper(a: number): number {
  return a + 1;
}

export const arrowFn = (n: number) => n * 2;
`;

describe('ts-symbol-resolver', () => {
  it('lists class, methods, constructor, function, arrow-const', () => {
    const paths = listSymbols(SRC, 'x.ts').map((s) => s.symbolPath);
    expect(paths).toContain('FactResolverService');
    expect(paths).toContain('FactResolverService.resolve');
    expect(paths).toContain('FactResolverService.constructor');
    expect(paths).toContain('FactResolverService.cfgNum');
    expect(paths).toContain('helper');
    expect(paths).toContain('arrowFn');
  });

  it('maps a line to its innermost enclosing symbol', () => {
    // "const y = id.length;" is inside resolve()
    const line = SRC.split('\n').findIndex((l) => l.includes('const y = id.length')) + 1;
    expect(enclosingSymbol(SRC, line, 'x.ts')).toBe('FactResolverService.resolve');
  });

  it('returns null outside any declaration (the import line)', () => {
    expect(enclosingSymbol(SRC, 1, 'x.ts')).toBeNull();
  });

  it('symbolExists checks presence', () => {
    expect(symbolExists(SRC, 'FactResolverService.resolve', 'x.ts')).toBe(true);
    expect(symbolExists(SRC, 'FactResolverService.gone', 'x.ts')).toBe(false);
  });

  it('non-TS content yields no symbols (caller falls back to file anchor)', () => {
    expect(listSymbols('plain text, not code', 'notes.md')).toEqual([]);
  });
});

describe('symbol-id', () => {
  it('composes + parses symbol anchors', () => {
    const id = symbolAnchorId('src/x.ts', 'Foo.bar');
    expect(id).toBe('src/x.ts#Foo.bar');
    expect(parseAnchor(id)).toEqual({ path: 'src/x.ts', symbolPath: 'Foo.bar' });
    expect(parseAnchor('src/x.ts')).toEqual({ path: 'src/x.ts' });
    expect(isSymbolAnchor(id)).toBe(true);
    expect(isSymbolAnchor('src/x.ts')).toBe(false);
  });
});

describe('makeSymbolAnchorRefiner', () => {
  const base: DecisionCandidate = {
    kind: 'decided',
    text: 't',
    anchor: 'x.ts',
    commit: 'c',
    validFrom: '2026-07-07T00:00:00Z',
  };
  const readFile = (p: string) => (p === 'x.ts' ? SRC : null);

  it('upgrades to a symbol anchor when the symbol resolves', () => {
    const refine = makeSymbolAnchorRefiner({ readFile });
    const out = refine({ ...base, symbol: 'FactResolverService.resolve' });
    expect(out.anchor).toBe('x.ts#FactResolverService.resolve');
  });

  it('keeps the file anchor when the symbol does not resolve', () => {
    const refine = makeSymbolAnchorRefiner({ readFile });
    expect(refine({ ...base, symbol: 'Ghost.method' }).anchor).toBe('x.ts');
  });

  it('keeps the file anchor when there is no symbol or file is gone', () => {
    const refine = makeSymbolAnchorRefiner({ readFile });
    expect(refine(base).anchor).toBe('x.ts');
    expect(
      refine({ ...base, anchor: 'gone.ts', symbol: 'Whatever' }).anchor,
    ).toBe('gone.ts');
  });
});

describe('validateAnchor (drift check)', () => {
  const readFile = (p: string) => (p === 'x.ts' ? SRC : null);
  it('present when the symbol still resolves (line-independent)', () => {
    expect(
      validateAnchor({ anchor: 'x.ts#FactResolverService.resolve', readFile }),
    ).toBe('present');
  });
  it('symbol_missing when the file exists but the symbol is gone', () => {
    expect(
      validateAnchor({ anchor: 'x.ts#FactResolverService.gone', readFile }),
    ).toBe('symbol_missing');
  });
  it('file_gone when the file no longer exists', () => {
    expect(validateAnchor({ anchor: 'deleted.ts#Foo.bar', readFile })).toBe(
      'file_gone',
    );
  });
  it('present for a bare file anchor that still exists', () => {
    expect(validateAnchor({ anchor: 'x.ts', readFile })).toBe('present');
  });
});

describe('reanchor', () => {
  it('re-anchors a missing symbol to a chosen current symbol', () => {
    const out = reanchor({
      source: SRC,
      path: 'x.ts',
      missingSymbolPath: 'FactResolverService.resolv', // typo'd/renamed
      choose: (candidates, missing) =>
        candidates.find((c) => c.startsWith('FactResolverService.res')) ??
        (missing ? null : null),
    });
    expect(out).toBe('x.ts#FactResolverService.resolve');
  });
  it('returns null when the chooser declines or picks a non-existent symbol', () => {
    expect(
      reanchor({
        source: SRC,
        path: 'x.ts',
        missingSymbolPath: 'Foo',
        choose: () => null,
      }),
    ).toBeNull();
    expect(
      reanchor({
        source: SRC,
        path: 'x.ts',
        missingSymbolPath: 'Foo',
        choose: () => 'Not.Real',
      }),
    ).toBeNull();
  });
});
