/**
 * Keyset cursors for list routes (src/common/page-cursor.ts) and the first
 * routes on them: a page starts strictly after the last key, so rows that
 * appear or vanish between requests do not shift what an offset would
 * have shifted, and a cursor from one list is refused by another.
 */
import { BadRequestException } from '@nestjs/common';
import { decodePageCursor, encodePageCursor } from '../src/common/page-cursor';
import { filterAndPage } from '../src/sources/public-projection';
import type { SourceSummary } from '../src/contracts/sources/sources.schema';

describe('page cursor', () => {
  it('round-trips its key and refuses another route’s cursor', () => {
    const c = encodePageCursor('sources', { after: 'crm:_' });
    expect(decodePageCursor('sources', c, { fields: ['after'] as const })).toEqual({
      after: 'crm:_',
    });
    expect(() => decodePageCursor('episodes', c, { fields: ['after'] as const })).toThrow(
      BadRequestException,
    );
    expect(() =>
      decodePageCursor('sources', 'not-a-cursor', { fields: ['after'] as const }),
    ).toThrow(BadRequestException);
  });

  it('accepts a pre-kind cursor only where the route says it issued them', () => {
    const legacy = Buffer.from(JSON.stringify({ t: '2026-01-01', id: 'episode:1' })).toString(
      'base64url',
    );
    expect(
      decodePageCursor('episodes', legacy, { fields: ['t', 'id'] as const, legacy: true }),
    ).toEqual({
      t: '2026-01-01',
      id: 'episode:1',
    });
    expect(() => decodePageCursor('episodes', legacy, { fields: ['t', 'id'] as const })).toThrow(
      BadRequestException,
    );
  });
});

describe('public sources list — keyset pages', () => {
  const summary = (sourceKey: string) =>
    ({
      sourceKey,
      declared: null,
      globalTrust: null,
      scopedDomains: 0,
    }) as unknown as SourceSummary;
  const all = ['a:_', 'b:_', 'c:_', 'd:_', 'e:_'].map(summary);

  it('walks every source once, in key order, with the last page carrying no cursor', () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = filterAndPage(all, { limit: 2, offset: 0, ...(after ? { after } : {}) });
      seen.push(...page.items.map((s) => s.sourceKey));
      if (!page.last) break;
      after = page.last;
    }
    expect(seen).toEqual(['a:_', 'b:_', 'c:_', 'd:_', 'e:_']);
  });

  it('a source removed between pages shifts nothing: the next page starts after the key', () => {
    const first = filterAndPage(all, { limit: 2, offset: 0 });
    const shrunk = all.filter((s) => s.sourceKey !== 'a:_');
    const next = filterAndPage(shrunk, { limit: 2, offset: 0, after: first.last! });
    expect(next.items.map((s) => s.sourceKey)).toEqual(['c:_', 'd:_']);
  });
});
