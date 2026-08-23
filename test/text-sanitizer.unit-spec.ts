/**
 * Shared Unicode sanitizer (G9, docs/roadmap/sota-gap-build-2026-08.md).
 *
 * The pack-text path (whitespace-collapsing) and the ingest path
 * (layout-preserving) share one strip primitive. This pins both, plus
 * the invariant that pack behaviour is byte-identical to the former
 * pack-tool-render local copy (covered end-to-end in pack-tools.socket).
 */
import {
  sanitizeIngestText,
  sanitizePackText,
  stripUnsafeUnicode,
} from '../src/common/text-sanitizer';

// RLO override, zero-width space, zero-width joiner, word joiner, BOM.
const RLO = '‮';
const ZWSP = '​';
const ZWJ = '‍';
const WJ = '⁠';
const BOM = '﻿';

describe('stripUnsafeUnicode', () => {
  it('strips bidi overrides, zero-width chars, and word joiners', () => {
    expect(stripUnsafeUnicode(`a${RLO}b${ZWSP}c${ZWJ}d${WJ}e${BOM}f`)).toBe(
      'abcdef',
    );
  });

  it('NFC-normalizes decomposed sequences', () => {
    // "é" as e + combining acute (U+0065 U+0301) → single U+00E9.
    expect(stripUnsafeUnicode('é').normalize('NFC')).toBe('é');
    expect(stripUnsafeUnicode('é')).toBe('é');
  });

  it('is idempotent and returns "" for non-strings', () => {
    const once = stripUnsafeUnicode(`x${ZWSP}y`);
    expect(stripUnsafeUnicode(once)).toBe(once);
    expect(stripUnsafeUnicode(42)).toBe('');
    expect(stripUnsafeUnicode(undefined)).toBe('');
    expect(stripUnsafeUnicode(null)).toBe('');
  });
});

describe('sanitizeIngestText (layout-preserving)', () => {
  it('strips invisibles but KEEPS newlines and tabs', () => {
    const dirty = `line one${RLO}\n\tline${ZWSP} two`;
    expect(sanitizeIngestText(dirty)).toBe('line one\n\tline two');
  });

  it('does not collapse runs of spaces or cap length', () => {
    const long = 'a  b   c' + ' '.repeat(50) + 'd';
    expect(sanitizeIngestText(long)).toBe(long);
    expect(sanitizeIngestText('x'.repeat(1000))).toHaveLength(1000);
  });

  it('passes non-strings through unchanged (never corrupts a payload)', () => {
    const obj = { a: 1 };
    expect(sanitizeIngestText(obj)).toBe(obj);
    expect(sanitizeIngestText(undefined)).toBeUndefined();
    expect(sanitizeIngestText(7)).toBe(7);
  });
});

describe('sanitizePackText (collapse + trim + cap)', () => {
  // Same expectations pack-tools.socket-spec pins on the former local copy.
  it('strips invisibles, collapses whitespace, trims', () => {
    expect(sanitizePackText(`a${RLO}b${ZWSP}cd  e\n\tf`, 100)).toBe('abcd e f');
  });

  it('caps to the requested length and rejects non-strings', () => {
    expect(sanitizePackText('x'.repeat(600), 500)).toHaveLength(500);
    expect(sanitizePackText(42, 10)).toBe('');
  });
});
