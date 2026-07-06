/**
 * Code-memory Phase 2b — client-side anchor sweep verdict builder (pure).
 */
import {
  buildAnchorVerdicts,
  heuristicChoose,
} from '../src/code-memory/anchor/sweep';

const SRC = `export class FactResolverService {
  async resolve(id: string): Promise<number> {
    return id.length;
  }
}
export function helper(a: number): number {
  return a + 1;
}
`;

const readFile = (p: string) => (p === 'x.ts' ? SRC : null);

describe('heuristicChoose', () => {
  it('picks the current symbol sharing the longest prefix (rename)', () => {
    expect(
      heuristicChoose(
        ['FactResolverService.resolve', 'helper'],
        'FactResolverService.resolv',
      ),
    ).toBe('FactResolverService.resolve');
  });
  it('declines when nothing meaningfully overlaps', () => {
    expect(heuristicChoose(['helper', 'other'], 'Zzz.Qqq')).toBeNull();
  });
});

describe('buildAnchorVerdicts', () => {
  it('ok for a resolving symbol anchor and a bare file anchor', () => {
    const v = buildAnchorVerdicts({
      anchors: ['x.ts#FactResolverService.resolve', 'x.ts'],
      readFile,
      choose: heuristicChoose,
    });
    expect(v).toEqual([
      { anchor: 'x.ts#FactResolverService.resolve', action: 'ok' },
      { anchor: 'x.ts', action: 'ok' },
    ]);
  });

  it('invalidates when the file is gone', () => {
    const v = buildAnchorVerdicts({
      anchors: ['deleted.ts#Foo.bar'],
      readFile,
      choose: heuristicChoose,
    });
    expect(v[0]).toMatchObject({ action: 'invalidate' });
  });

  it('re-anchors a renamed symbol to its closest current match', () => {
    const v = buildAnchorVerdicts({
      anchors: ['x.ts#FactResolverService.resolv'],
      readFile,
      choose: heuristicChoose,
    });
    expect(v[0]).toEqual({
      anchor: 'x.ts#FactResolverService.resolv',
      action: 'reanchor',
      newAnchor: 'x.ts#FactResolverService.resolve',
    });
  });

  it('invalidates when the symbol is gone with no plausible match', () => {
    const v = buildAnchorVerdicts({
      anchors: ['x.ts#Totally.Different'],
      readFile,
      choose: heuristicChoose,
    });
    expect(v[0]).toMatchObject({ action: 'invalidate' });
  });
});
