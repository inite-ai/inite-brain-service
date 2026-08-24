/**
 * Code-memory Phase 2b — client-side anchor sweep verdict builder (pure).
 */
import {
  buildAnchorVerdicts,
  heuristicChoose,
  SweepBlastRadiusError,
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
      heuristicChoose(['FactResolverService.resolve', 'helper'], 'FactResolverService.resolv'),
    ).toBe('FactResolverService.resolve');
  });
  it('declines when nothing meaningfully overlaps', () => {
    expect(heuristicChoose(['helper', 'other'], 'Zzz.Qqq')).toBeNull();
  });
  it('declines a weak stem match (get_user → get_post is not a rename)', () => {
    expect(heuristicChoose(['get_post', 'other'], 'get_user')).toBeNull();
  });
  it('declines when two candidates tie on the top prefix (ambiguous)', () => {
    // Both share "handle" (6) with the gone "handleThing" — don't guess.
    expect(heuristicChoose(['handleFoo', 'handleBar'], 'handleThing')).toBeNull();
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

  it('refuses a mass-invalidate blast radius (misconfigured run)', () => {
    // 12 anchors, none of whose files exist → 100% would invalidate. That's a
    // wrong-cwd run, not a real deletion — abort instead of retracting all.
    const anchors = Array.from({ length: 12 }, (_, i) => `gone_${i}.ts#Foo.bar`);
    expect(() =>
      buildAnchorVerdicts({ anchors, readFile: () => null, choose: heuristicChoose }),
    ).toThrow(SweepBlastRadiusError);
  });

  it('does not guard a small anchor set (legitimately high ratio)', () => {
    // Below minAnchorsForGuard — 2 gone files must not trip the guard.
    const v = buildAnchorVerdicts({
      anchors: ['gone_a.ts#Foo.bar', 'gone_b.ts#Baz.qux'],
      readFile: () => null,
      choose: heuristicChoose,
    });
    expect(v.every((x) => x.action === 'invalidate')).toBe(true);
  });

  it('honors the override for a confirmed mass removal', () => {
    const anchors = Array.from({ length: 12 }, (_, i) => `gone_${i}.ts#Foo.bar`);
    const v = buildAnchorVerdicts({
      anchors,
      readFile: () => null,
      choose: heuristicChoose,
      maxInvalidateRatio: 1,
    });
    expect(v).toHaveLength(12);
    expect(v.every((x) => x.action === 'invalidate')).toBe(true);
  });
});
