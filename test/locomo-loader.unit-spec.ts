/**
 * Coverage for the LoCoMo loader.
 *
 * Pins normalization: session_N keys → ordered sessions[] array,
 * date_time → ISO, both standard and human ("1:56 pm on 8 May, 2023")
 * forms.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadLocomoDataset, normalizeSample } from '../test/eval/locomo/loader';
import type { LocomoSample } from '../test/eval/locomo/types';

const fixture: LocomoSample = {
  sample_id: 'conv-1',
  conversation: {
    speaker_a: 'Alice',
    speaker_b: 'Bob',
    session_2: [
      { dia_id: 'D2:1', speaker: 'Bob', text: 'second' },
    ],
    session_2_date_time: '8 May, 2023',
    session_1: [
      { dia_id: 'D1:1', speaker: 'Alice', text: 'first' },
      { dia_id: 'D1:2', speaker: 'Bob', text: 'response' },
    ],
    session_1_date_time: '2023-05-01T12:00:00Z',
  },
  qa: [
    {
      question: 'What did Alice say first?',
      answer: 'first',
      category: 1,
      evidence: ['D1:1'],
    },
  ],
};

describe('LoCoMo loader', () => {
  it('normalizes a single sample into ordered sessions', () => {
    const norm = normalizeSample(fixture);
    expect(norm.sampleId).toBe('conv-1');
    expect(norm.speakerA).toBe('Alice');
    expect(norm.speakerB).toBe('Bob');
    expect(norm.sessions.map((s) => s.index)).toEqual([1, 2]);
    expect(norm.sessions[0]!.turns).toHaveLength(2);
    expect(norm.sessions[1]!.turns).toHaveLength(1);
  });

  it('parses ISO datetimes through unchanged', () => {
    const norm = normalizeSample(fixture);
    expect(norm.sessions[0]!.dateTime).toBe('2023-05-01T12:00:00.000Z');
  });

  it('coerces non-string gold answers to strings (LoCoMo has numeric answers)', () => {
    // Real LoCoMo stores some gold answers as JSON numbers (counts, years);
    // the token-F1 scorer does answer.toLowerCase() and would throw on a
    // number, aborting the whole run. The loader coerces at the boundary.
    const withNumeric = {
      ...fixture,
      // Runtime numeric/null answers (as the real dataset stores them),
      // cast to the typed shape — the loader coerces them at runtime.
      qa: [
        { question: 'How many?', answer: 7, category: 2, evidence: [] },
        { question: 'Which year?', answer: 2022, category: 3, evidence: [] },
        { question: 'Nothing?', answer: null, category: 5, evidence: [] },
      ] as unknown as typeof fixture.qa,
    };
    const norm = normalizeSample(withNumeric);
    expect(norm.qa.map((q) => q.answer)).toEqual(['7', '2022', '']);
    expect(norm.qa.every((q) => typeof q.answer === 'string')).toBe(true);
  });

  it('best-effort parses human "8 May, 2023" form', () => {
    const norm = normalizeSample(fixture);
    expect(norm.sessions[1]!.dateTime).toMatch(/^2023-05-08T/);
  });

  it('surfaces adversarial_answer for cat5 and leaves answer empty', () => {
    const advSample = {
      ...fixture,
      qa: [
        {
          question: 'What did Alice realize?',
          category: 5,
          evidence: ['D1:1'],
          adversarial_answer: 'self-care is important',
        },
      ] as unknown as typeof fixture.qa,
    };
    const norm = normalizeSample(advSample);
    expect(norm.qa[0]!.answer).toBe('');
    expect(norm.qa[0]!.adversarialAnswer).toBe('self-care is important');
  });

  it('loads from disk and reads both shape variants', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'locomo-'));
    const wrappedPath = path.join(tmp, 'wrapped.json');
    const bareArrayPath = path.join(tmp, 'bare.json');
    await fs.writeFile(wrappedPath, JSON.stringify({ samples: [fixture] }));
    await fs.writeFile(bareArrayPath, JSON.stringify([fixture]));

    const wrapped = await loadLocomoDataset(wrappedPath);
    const bare = await loadLocomoDataset(bareArrayPath);

    expect(wrapped).toHaveLength(1);
    expect(bare).toHaveLength(1);
    expect(wrapped[0]!.qa).toHaveLength(1);
  });
});
