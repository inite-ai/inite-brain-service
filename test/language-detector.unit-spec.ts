import { detectLanguage } from '../src/ai/locale/language-detector';

describe('detectLanguage', () => {
  it('detects English from stopwords', () => {
    const r = detectLanguage('The quick brown fox jumps over the lazy dog.');
    expect(r.language).toBe('en');
    expect(r.script).toBe('Latn');
  });

  it('detects Russian via Cyrillic block', () => {
    const r = detectLanguage('Мария — технический директор Acme.');
    expect(r.language).toBe('ru');
    expect(r.script).toBe('Cyrl');
  });

  it('detects Spanish from stopwords', () => {
    const r = detectLanguage('La empresa es importante para los clientes.');
    expect(r.language).toBe('es');
    expect(r.script).toBe('Latn');
  });

  it('detects French from stopwords', () => {
    const r = detectLanguage("Je suis content de vous voir aujourd'hui.");
    expect(r.language).toBe('fr');
    expect(r.script).toBe('Latn');
  });

  it('detects German from stopwords', () => {
    const r = detectLanguage('Ich habe ein neues Buch gekauft und es ist gut.');
    expect(r.language).toBe('de');
  });

  it('detects Japanese via Hiragana/Katakana', () => {
    const r = detectLanguage('これはテストです。');
    expect(r.language).toBe('ja');
    expect(r.script).toBe('Hira');
  });

  it('detects Chinese when no kana present', () => {
    const r = detectLanguage('这是一个测试。');
    expect(r.language).toBe('zh');
    expect(r.script).toBe('Hani');
  });

  it('detects Korean via Hangul', () => {
    const r = detectLanguage('이것은 시험이다.');
    expect(r.language).toBe('ko');
    expect(r.script).toBe('Hang');
  });

  it('detects Arabic', () => {
    const r = detectLanguage('هذا اختبار بسيط للنص العربي.');
    expect(r.language).toBe('ar');
    expect(r.script).toBe('Arab');
  });

  it('returns "und" on empty / pure-punctuation input', () => {
    expect(detectLanguage('').language).toBe('und');
    expect(detectLanguage('   !!! ???   ').language).toBe('und');
  });

  it('returns a confidence number ∈ [0, 1]', () => {
    const r = detectLanguage('The cat sat on the mat.');
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('correctly handles mixed-script cyrillic+latin (cyrillic-dominant)', () => {
    const r = detectLanguage('Acme Corp — Мария работает CTO.');
    expect(r.language).toBe('ru');
  });
});

describe('detectLanguage counts words, not characters, and ignores machine tokens', () => {
  // The answer plane appends a citation to every answer. On the Chinese
  // sentence below that citation alone is 34 Latin letters against 15
  // Han ones, and a character count called the answer English with
  // confidence 0 — for every Chinese answer the brain has ever produced.
  it('a Chinese answer with a Latin brand and a citation is Chinese', () => {
    const r = detectLanguage(
      'Orbital Dynamics 的工程负责人是玛丽亚·阿尔瓦雷斯 [knowledge_fact:392mtme48rfejfl1jhvg]。',
    );
    expect(r.language).toBe('zh');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('a Russian answer with a Latin brand and a citation is Russian', () => {
    const r = detectLanguage(
      'Инженерным отделом в Orbital Dynamics руководит Мария Альварес [knowledge_fact:rlhuet6bmkrpye4qtmm7].',
    );
    expect(r.language).toBe('ru');
  });

  it('a longer Latin brand does not outvote a Chinese sentence', () => {
    // By characters this is 8 Han against 36 Latin; by words, 6 against 3.
    expect(
      detectLanguage('Orbital Dynamics International Holdings 的工程负责人是谁').language,
    ).toBe('zh');
  });

  it('a citation, a URL or a bare identifier is text in no language', () => {
    expect(detectLanguage('[knowledge_fact:392mtme48rfejfl1jhvg]').language).toBe('und');
    expect(detectLanguage('https://example.com/a/b').language).toBe('und');
    expect(
      detectLanguage('Мария [knowledge_fact:abc] https://x.io/y 392mtme48rfejfl1jhvgabcd').language,
    ).toBe('ru');
  });

  it('KNOWN LIMIT: an English sentence quoting a Han-scripted name verbatim reads as Chinese', () => {
    // ICU cannot segment a phonetic Chinese rendering of a foreign name
    // into dictionary words, so it yields seven one-character "words"
    // that outvote five English ones. In practice the answer plane
    // romanises names in an English answer; this is pinned so a future
    // change to the rule is measured against it rather than surprised.
    expect(detectLanguage('The head of engineering is 玛丽亚·阿尔瓦雷斯.').language).toBe('zh');
  });
});
