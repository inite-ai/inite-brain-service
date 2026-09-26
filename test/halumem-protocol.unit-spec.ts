/**
 * The HaluMem harness's own machinery (test/eval/halumem): the protocol
 * text itself is read from the toolkit at run time, so what is pinned here
 * is how it is read and applied — Python's str.format, the triple-quoted
 * constants, the judge's JSON block — and that the metric arithmetic is
 * evaluation.py's.
 */
import {
  f1,
  judgeJson,
  pyFormat,
  pythonStringConstants,
  scoreAccuracy,
  scoreIntegrity,
  scoreQa,
  scoreUpdates,
} from './eval/halumem/protocol';
import { haluMemTime, judgeDialogue, sessionTranscript, userNameOf } from './eval/halumem/dataset';

describe('reading the toolkit', () => {
  const py = [
    'import os',
    'EVALUATION_PROMPT_FOR_QUESTION = """Q: {question}',
    'Answer as ```json {{"evaluation_result": "Correct"}} ```',
    '"""',
    'OTHER = 1',
  ].join('\n');

  it('takes a module-level triple-quoted constant verbatim', () => {
    expect(pythonStringConstants(py, ['EVALUATION_PROMPT_FOR_QUESTION'])).toEqual({
      EVALUATION_PROMPT_FOR_QUESTION:
        'Q: {question}\nAnswer as ```json {{"evaluation_result": "Correct"}} ```\n',
    });
  });

  it('a renamed constant fails the run instead of judging with nothing', () => {
    expect(() => pythonStringConstants(py, ['EVALUATION_PROMPT_FOR_MEMORY_ACCURACY'])).toThrow(
      /not found/,
    );
  });

  it('str.format: fields filled, doubled braces unescaped, a missing field throws', () => {
    expect(pyFormat('{{"a": "{x}"}} {x}', { x: '1' })).toBe('{"a": "1"} 1');
    expect(() => pyFormat('{y}', {})).toThrow(/\{y\}/);
  });

  it('the verdict is the first fenced json block', () => {
    expect(judgeJson('thinking…\n```json\n{"score": 2}\n```\n```json\n{"score": 0}\n```')).toEqual({
      score: 2,
    });
    expect(() => judgeJson('score: 2')).toThrow(/No JSON block/);
  });
});

describe('the dataset', () => {
  it('reads the name and the time the way the toolkit does', () => {
    expect(userNameOf('[Recorded on …] Name: Martin Mark; Gender: Male; …')).toBe('Martin Mark');
    expect(haluMemTime('Sep 04, 2025, 18:42:18')).toBe('2025-09-04T18:42:18.000Z');
    expect(() => haluMemTime('2025-09-04')).toThrow(/unparseable/);
  });

  const session = {
    start_time: 'Sep 04, 2025, 18:42:18',
    memory_points: [],
    dialogue: [
      {
        role: 'user' as const,
        content: 'I moved\nto Columbus.',
        timestamp: 'Sep 04, 2025, 18:42:18',
      },
      { role: 'assistant' as const, content: 'Noted!', timestamp: 'Sep 04, 2025, 18:42:30' },
    ],
  };

  it('a session is a transcript: one speaker line per turn', () => {
    expect(sessionTranscript(session, 'Martin Mark')).toBe(
      'Martin Mark: I moved to Columbus.\nAssistant: Noted!',
    );
  });

  it("the judge's dialogue keeps the toolkit's shape", () => {
    expect(judgeDialogue(session)).toBe(
      '[Sep 04, 2025, 18:42:18]user: I moved\nto Columbus.\n[Sep 04, 2025, 18:42:30]assistant: Noted!\n',
    );
  });
});

describe('the metrics (evaluation.py)', () => {
  it('integrity: recall counts full matches; weighting halves the score; interference rejected = 0', () => {
    const s = scoreIntegrity([
      { memorySource: 'system', memoryType: 'Persona', importance: 1, score: 2 },
      { memorySource: 'system', memoryType: 'Event', importance: 0.5, score: 1 },
      { memorySource: 'system', memoryType: 'Event', importance: 0.5, score: null },
      { memorySource: 'interference', memoryType: 'Event', importance: 0.5, score: 0 },
      { memorySource: 'interference', memoryType: 'Event', importance: 0.5, score: 2 },
    ]);
    expect(s['recall(all)']).toBeCloseTo(1 / 3);
    expect(s['recall(valid)']).toBeCloseTo(1 / 2);
    expect(s['weighted_recall(all)']).toBeCloseTo((0.5 * 2 * 1 + 0.5 * 1 * 0.5) / 2);
    expect(s['interference_accuracy(all)']).toBeCloseTo(1 / 2);
  });

  it('accuracy: target precision over the memories the judge placed in the gold set', () => {
    const s = scoreAccuracy([
      { includedInGolden: true, score: 2 },
      { includedInGolden: true, score: 0 },
      { includedInGolden: false, score: 1 },
    ]);
    expect(s['target_accuracy(all)']).toBeCloseTo(0.5);
    expect(s['weighted_accuracy(all)']).toBeCloseTo((1 + 0 + 0.5) / 3);
    expect(f1(0.5, 0.5)).toBeCloseTo(0.5);
    expect(f1(0, 0)).toBe(0);
    expect(f1(null, 0.5)).toBeNull();
  });

  it('update and QA ratios; an unparsed verdict counts in (all) and not in (valid)', () => {
    const u = scoreUpdates([
      { memoryType: 'x', verdict: 'Correct' },
      { memoryType: 'x', verdict: 'Hallucination' },
      { memoryType: 'x', verdict: null },
    ]);
    expect(u['correct_ratio(all)']).toBeCloseTo(1 / 3);
    expect(u['correct_ratio(valid)']).toBeCloseTo(1 / 2);
    const q = scoreQa([
      { questionType: 'Memory Boundary', verdict: 'Omission' },
      { questionType: 'Memory Boundary', verdict: 'Other' },
    ]);
    expect(q['omission_ratio(all)']).toBeCloseTo(1 / 2);
    expect(q.valid_num).toBe(1);
  });
});
