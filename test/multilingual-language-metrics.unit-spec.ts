import { detectLanguage } from './eval/multilingual/script-detect';
import {
  answerLanguageCorrectness,
  answerLanguageMismatches,
} from './eval/metrics/answer-language';
import { expectedCalibrationError, abstentionSplit } from './eval/metrics/abstention-calibration';

describe('detectLanguage — script classes', () => {
  it('Cyrillic → ru', () => {
    expect(detectLanguage('Технический директор руководит отделом').lang).toBe('ru');
  });

  it('Han (CJK) → zh', () => {
    expect(detectLanguage('技术总监负责工程部门').lang).toBe('zh');
  });

  it('Arabic (RTL) → ar', () => {
    expect(detectLanguage('مدير الهندسة هو المسؤول').lang).toBe('ar');
  });

  it('Devanagari → hi', () => {
    expect(detectLanguage('इंजीनियरिंग प्रमुख हमारे सीटीओ हैं').lang).toBe('hi');
  });

  it('Latin English stopwords → en', () => {
    expect(detectLanguage('The head of engineering is our CTO.').lang).toBe('en');
  });

  it('Latin German stopwords → de', () => {
    expect(detectLanguage('Der Leiter der Technik ist unser CTO.').lang).toBe('de');
  });

  it('Latin Spanish stopwords → es', () => {
    expect(detectLanguage('El director de ingeniería es nuestro CTO.').lang).toBe('es');
  });

  it('empty → und', () => {
    expect(detectLanguage('   ').lang).toBe('und');
  });

  it('digits/punctuation only → und', () => {
    expect(detectLanguage('12345 !!! ---').lang).toBe('und');
  });

  it('confidence is reported for a clear non-Latin case', () => {
    expect(detectLanguage('技术总监').confidence).toBeGreaterThan(0.5);
  });
});

describe('answerLanguageCorrectness', () => {
  it('all match → 1.0', () => {
    expect(
      answerLanguageCorrectness([
        { detected: 'ru', intended: 'ru' },
        { detected: 'en', intended: 'en' },
      ]),
    ).toBe(1);
  });

  it('half match → 0.5', () => {
    expect(
      answerLanguageCorrectness([
        { detected: 'ru', intended: 'ru' },
        { detected: 'en', intended: 'ru' },
      ]),
    ).toBe(0.5);
  });

  it('null detection counts as mismatch', () => {
    expect(answerLanguageCorrectness([{ detected: null, intended: 'ru' }])).toBe(0);
  });

  it('empty → null', () => {
    expect(answerLanguageCorrectness([])).toBeNull();
  });

  it('mismatch count is a plain diagnostic', () => {
    expect(
      answerLanguageMismatches([
        { detected: 'ru', intended: 'ru' },
        { detected: 'en', intended: 'ru' },
        { detected: null, intended: 'zh' },
      ]),
    ).toBe(2);
  });
});

describe('expectedCalibrationError', () => {
  it('perfectly calibrated extremes → 0', () => {
    expect(
      expectedCalibrationError([
        { confidence: 1, correct: true },
        { confidence: 0, correct: false },
      ]),
    ).toBeCloseTo(0, 6);
  });

  it('confident-but-wrong → large ECE', () => {
    expect(
      expectedCalibrationError([
        { confidence: 0.9, correct: false },
        { confidence: 0.9, correct: false },
      ]),
    ).toBeCloseTo(0.9, 6);
  });

  it('clamps out-of-range confidence into the last bin', () => {
    // confidence 1.2 clamps to 1.0 → bin 9, accuracy 1 → error 0.
    expect(expectedCalibrationError([{ confidence: 1.2, correct: true }])).toBeCloseTo(0, 6);
  });

  it('empty → null', () => {
    expect(expectedCalibrationError([])).toBeNull();
  });
});

describe('abstentionSplit', () => {
  it('perfect policy → no over-reject, no hallucination', () => {
    const s = abstentionSplit([
      { shouldAnswer: true, abstained: false },
      { shouldAnswer: false, abstained: true },
    ]);
    expect(s.overRejectRate).toBe(0);
    expect(s.hallucinationRate).toBe(0);
    expect(s.correctAnswerRate).toBe(1);
    expect(s.correctAbstainRate).toBe(1);
    expect(s.answerable).toBe(1);
    expect(s.falsePremise).toBe(1);
  });

  it('inverted policy → over-reject AND hallucinate at 1.0', () => {
    const s = abstentionSplit([
      { shouldAnswer: true, abstained: true },
      { shouldAnswer: false, abstained: false },
    ]);
    expect(s.overRejectRate).toBe(1);
    expect(s.hallucinationRate).toBe(1);
  });

  it('no false-premise cases → hallucinationRate null', () => {
    const s = abstentionSplit([{ shouldAnswer: true, abstained: false }]);
    expect(s.hallucinationRate).toBeNull();
    expect(s.correctAbstainRate).toBeNull();
    expect(s.falsePremise).toBe(0);
  });

  it('empty → both rates null', () => {
    const s = abstentionSplit([]);
    expect(s.overRejectRate).toBeNull();
    expect(s.hallucinationRate).toBeNull();
  });
});
