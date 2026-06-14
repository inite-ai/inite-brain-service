/**
 * Unit-test for extractCollapseEditsLocally — lexical word-boundary
 * scan over learned collapse patterns. Verifies word-boundary
 * enforcement, longest-match precedence, multi-match,
 * empty-snapshot/message degrade.
 */
import {
  extractCollapseEditsLocally,
  type CollapseSnapshot,
} from '../src/admin/collapse-pattern.service';

function mkSnap(
  pairs: Array<[string, string]>,
): CollapseSnapshot {
  const m = new Map<string, { pattern: string; replacement: string }>();
  for (const [pattern, replacement] of pairs) {
    m.set(pattern.toLowerCase(), { pattern, replacement });
  }
  return { patterns: m };
}

describe('extractCollapseEditsLocally', () => {
  it('returns [] on empty snapshot', () => {
    expect(extractCollapseEditsLocally('moved to Berlin', mkSnap([]))).toEqual(
      [],
    );
  });

  it('returns [] on empty message', () => {
    expect(
      extractCollapseEditsLocally('', mkSnap([['moved to', 'lives in']])),
    ).toEqual([]);
  });

  it('matches a known pattern with word boundaries', () => {
    const snap = mkSnap([['moved to', 'lives in']]);
    const out = extractCollapseEditsLocally('Maria moved to Berlin', snap);
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('moved to');
    expect(out[0].replacement).toBe('lives in');
    expect(out[0].span).toEqual({
      text: 'moved to',
      start: 6,
      end: 14,
    });
  });

  it('rejects matches inside a longer word (no word boundary)', () => {
    const snap = mkSnap([['moved', 'lives in']]);
    // "removed" contains "moved" without word boundary
    expect(extractCollapseEditsLocally('She removed it', snap)).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const snap = mkSnap([['moved to', 'lives in']]);
    const out = extractCollapseEditsLocally('She MOVED TO Paris', snap);
    expect(out).toHaveLength(1);
    expect(out[0].span.text).toBe('MOVED TO');
  });

  it('prefers longest match when patterns overlap', () => {
    const snap = mkSnap([
      ['moved', 'lives'],
      ['moved from', 'lives in'],
    ]);
    const out = extractCollapseEditsLocally(
      'Maria moved from Berlin',
      snap,
    );
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe('moved from');
  });

  it('emits multiple non-overlapping matches in one message', () => {
    const snap = mkSnap([
      ['moved to', 'lives in'],
      ['joined as', 'is the'],
    ]);
    const out = extractCollapseEditsLocally(
      'She moved to Dublin and joined as CTO',
      snap,
    );
    expect(out.map((c) => c.pattern).sort()).toEqual([
      'joined as',
      'moved to',
    ]);
  });

  it('handles multilingual patterns (Cyrillic)', () => {
    const snap = mkSnap([['переехал в', 'живёт в']]);
    const out = extractCollapseEditsLocally(
      'Мария переехал в Берлин',
      snap,
    );
    expect(out).toHaveLength(1);
    expect(out[0].replacement).toBe('живёт в');
    expect(out[0].span.text).toBe('переехал в');
  });

  it('matches at message boundaries', () => {
    const snap = mkSnap([['moved to', 'lives in']]);
    expect(
      extractCollapseEditsLocally('moved to Berlin', snap),
    ).toHaveLength(1);
    expect(
      extractCollapseEditsLocally('Maria moved to', snap),
    ).toHaveLength(1);
  });

  it('preserves source casing in span.text', () => {
    const snap = mkSnap([['moved to', 'lives in']]);
    const out = extractCollapseEditsLocally('Maria Moved To Berlin', snap);
    expect(out[0].span.text).toBe('Moved To');
  });
});
