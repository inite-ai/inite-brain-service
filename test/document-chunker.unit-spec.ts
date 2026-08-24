/**
 * Unit-test for chunkDocument — paragraph-boundary-aware splitting with
 * document-coordinate spans and tail overlap. Every chunk must fit the
 * extractor clamp (16K); coordinates must map back into the source text.
 */
import { chunkDocument } from '../src/documents/chunker';
import { LLM_INPUT_LIMITS } from '../src/common/input-limits';

describe('chunkDocument', () => {
  it('empty input → []', () => {
    expect(chunkDocument('')).toEqual([]);
  });

  it('short text → single chunk covering the whole document', () => {
    const text = 'Maria is the CTO at Acme.';
    const out = chunkDocument(text);
    expect(out).toEqual([{ seq: 0, text, charStart: 0, charEnd: text.length }]);
  });

  it('text at exactly the max fits in one chunk', () => {
    const text = 'a'.repeat(LLM_INPUT_LIMITS.mentionText);
    expect(chunkDocument(text)).toHaveLength(1);
  });

  it('long text splits; every chunk ≤ 16K and coordinates map back', () => {
    const paragraph = `${'word '.repeat(400)}\n\n`; // ~2K chars each
    const text = paragraph.repeat(30); // ~60K chars
    const out = chunkDocument(text);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(LLM_INPUT_LIMITS.mentionText);
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('prefers paragraph boundaries for the cut', () => {
    const paragraph = `${'x'.repeat(5_000)}\n\n`;
    const text = paragraph.repeat(5); // 25K → must split
    const out = chunkDocument(text);
    // First chunk should end right after a paragraph boundary, not mid-run.
    expect(out[0]!.text.endsWith('\n\n')).toBe(true);
  });

  it('consecutive chunks overlap so straddling content is fully visible', () => {
    const paragraph = `${'word '.repeat(400)}\n\n`;
    const text = paragraph.repeat(30);
    const out = chunkDocument(text);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.charStart).toBeLessThan(out[i - 1]!.charEnd);
    }
  });

  it('boundary-free text still makes progress via hard cuts', () => {
    const text = 'a'.repeat(50_000);
    const out = chunkDocument(text);
    expect(out.length).toBeGreaterThan(3);
    expect(out[out.length - 1]!.charEnd).toBe(text.length);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.charStart).toBeGreaterThan(out[i - 1]!.charStart);
    }
  });

  it('covers the entire document — no gaps between chunks', () => {
    const text = `${'sentence one. '.repeat(2_000)}`;
    const out = chunkDocument(text);
    expect(out[0]!.charStart).toBe(0);
    for (let i = 1; i < out.length; i++) {
      // Overlap means next start ≤ previous end; never a gap.
      expect(out[i]!.charStart).toBeLessThanOrEqual(out[i - 1]!.charEnd);
    }
    expect(out[out.length - 1]!.charEnd).toBe(text.length);
  });
});
