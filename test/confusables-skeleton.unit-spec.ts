/**
 * Multilingual Tier 3 — Unicode identifier policy (INGEST_CONFUSABLES_CHECK).
 *
 * A curated UTS-39-style confusables skeleton + locale-invariant casefold,
 * used ONLY as a match key / risk signal — the caller preserves the original
 * surface and NEVER auto-blocks or auto-merges on it. These pin the pure
 * helpers in src/common/text-sanitizer.ts.
 */
import {
  analyzeConfusables,
  confusableSkeleton,
  localeInvariantCasefold,
} from '../src/common/text-sanitizer';

// "paypal" with a Cyrillic а (U+0430) in place of the ASCII a — MIXED script.
const CYRILLIC_A = 'а';
const PAYPAL_MIXED = `p${CYRILLIC_A}ypal`;
// "paypal" spelled ENTIRELY in Cyrillic homoglyphs (р а у р а ӏ) — a
// single-script disguise that mixed-script detection alone would miss.
const PAYPAL_DISGUISED = 'раураӏ';
const ZWSP = '​';

describe('localeInvariantCasefold', () => {
  it('lowercases via Unicode default mapping (NOT the Turkic locale rule)', () => {
    expect(localeInvariantCasefold('ABC')).toBe('abc');
    // Locale-invariance: a Turkish locale would fold I → ı; the default
    // mapping folds I → i. We must get the default.
    expect(localeInvariantCasefold('I')).toBe('i');
  });

  it('does NOT full-casefold ß → ss (simple casefold, documented deviation)', () => {
    expect(localeInvariantCasefold('Straße')).toBe('straße');
  });

  it('returns "" for non-strings', () => {
    expect(localeInvariantCasefold(42)).toBe('');
    expect(localeInvariantCasefold(undefined)).toBe('');
  });
});

describe('confusableSkeleton', () => {
  it('maps Cyrillic/Greek homoglyphs to their ASCII skeleton', () => {
    // The spoof and the genuine ASCII name collapse to the SAME skeleton —
    // that shared key is what a reviewer groups on to spot a collision.
    expect(confusableSkeleton(PAYPAL_MIXED)).toBe('paypal');
    expect(confusableSkeleton(PAYPAL_DISGUISED)).toBe('paypal');
    expect(confusableSkeleton('paypal')).toBe('paypal');
    expect(confusableSkeleton(PAYPAL_MIXED)).toBe(confusableSkeleton('paypal'));
    expect(confusableSkeleton(PAYPAL_DISGUISED)).toBe(confusableSkeleton('paypal'));
  });

  it('strips zero-width chars before skeletonizing', () => {
    expect(confusableSkeleton(`ad${ZWSP}min`)).toBe('admin');
  });

  it('leaves a plain single-script ASCII name unchanged', () => {
    expect(confusableSkeleton('acme corp')).toBe('acme corp');
  });
});

describe('analyzeConfusables (risk signal)', () => {
  it('flags a MIXED-script homoglyph spoof', () => {
    const risk = analyzeConfusables(PAYPAL_MIXED);
    expect(risk.flagged).toBe(true);
    expect(risk.mixedScript).toBe(true);
    expect(risk.skeleton).toBe('paypal');
  });

  it('flags a DISGUISED single-script spoof (skeleton is a full Latin word)', () => {
    const risk = analyzeConfusables(PAYPAL_DISGUISED);
    expect(risk.flagged).toBe(true);
    expect(risk.disguisedScript).toBe(true);
    expect(risk.mixedScript).toBe(false); // no ASCII Latin — not "mixed"
    expect(risk.skeleton).toBe('paypal');
  });

  it('does NOT flag a genuine single-script ASCII name', () => {
    const risk = analyzeConfusables('paypal');
    expect(risk.flagged).toBe(false);
    expect(risk.mixedScript).toBe(false);
    expect(risk.disguisedScript).toBe(false);
    expect(risk.hasConfusables).toBe(false);
  });

  it('does NOT flag a genuine all-Cyrillic word (single script, real language)', () => {
    // "пример" is entirely Cyrillic; its skeleton keeps unmapped Cyrillic
    // letters (пpимеp), so it is neither mixed nor disguised. hasConfusables
    // is true (informational only) — the point is flagged stays false, so a
    // Cyrillic-native tenant is not swamped with false positives.
    const risk = analyzeConfusables('пример');
    expect(risk.flagged).toBe(false);
    expect(risk.mixedScript).toBe(false);
    expect(risk.disguisedScript).toBe(false);
    expect(risk.hasConfusables).toBe(true);
  });

  it('is a pure signal — returns a profile and never throws on odd input', () => {
    expect(() => analyzeConfusables('')).not.toThrow();
    expect(analyzeConfusables('').flagged).toBe(false);
    // Non-string input is tolerated (defensive) and yields an empty profile.
    expect(analyzeConfusables(undefined as unknown as string).flagged).toBe(false);
  });
});
