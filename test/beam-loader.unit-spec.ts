/**
 * Coverage for the BEAM loader + shared eval checkpointing.
 *
 * Pins the normalized-JSON contract (produced by
 * scripts/fetch-beam-dataset.py), the question-date convention (a week
 * after the last session), and the JSONL resume semantics that full paid
 * runs depend on (errored rows retried, completed rows skipped).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadBeam,
  beamQuestionDateIso,
  BeamConversation,
} from '../test/eval/beam/loader';
import { loadCheckpoint, appendCheckpoint } from '../test/eval/checkpoint';

const conv: BeamConversation = {
  conversationId: '1',
  split: '100K',
  category: 'Coding',
  title: 'Budget tracker',
  sessions: [
    {
      sessionId: '1:0',
      dateIso: '2024-03-15T09:00:00.000Z',
      turns: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    },
    {
      sessionId: '1:1',
      dateIso: '2024-04-05T09:00:00.000Z',
      turns: [{ role: 'user', content: 'later session' }],
    },
  ],
  questions: [
    {
      questionId: '1:abstention:0',
      ability: 'abstention',
      question: 'unanswerable?',
      gold: 'There is no information about this.',
      difficulty: 'medium',
      rubric: ['no information'],
      sourceChatIds: [],
    },
  ],
};

describe('BEAM loader', () => {
  it('round-trips the normalized JSON', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'beam-')), 'b.json');
    await fs.writeFile(file, JSON.stringify([conv]));
    const loaded = await loadBeam(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.questions[0]!.ability).toBe('abstention');
    expect(loaded[0]!.sessions[1]!.turns[0]!.content).toBe('later session');
  });

  it('rejects an empty dataset', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'beam-')), 'e.json');
    await fs.writeFile(file, '[]');
    await expect(loadBeam(file)).rejects.toThrow('no conversations');
  });

  it('dates questions a week after the last session', () => {
    expect(beamQuestionDateIso(conv)).toBe('2024-04-12T09:00:00.000Z');
  });
});

describe('eval checkpoint', () => {
  it('is a no-op without a path and empty on a fresh file', async () => {
    await expect(appendCheckpoint(undefined, { a: 1 })).resolves.toBeUndefined();
    const missing = path.join(os.tmpdir(), 'beam-ckpt-never-created.jsonl');
    const done = await loadCheckpoint<{ id: string }>(missing, (r) => r.id);
    expect(done.size).toBe(0);
  });

  it('round-trips appended rows keyed by id', async () => {
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-')),
      'run.jsonl',
    );
    await appendCheckpoint(file, { id: 'q1', judgeCorrect: true });
    await appendCheckpoint(file, { id: 'q2', judgeCorrect: false });
    // Later rows for the same key win — a rerun's fresh score replaces stale.
    await appendCheckpoint(file, { id: 'q2', judgeCorrect: true });
    const done = await loadCheckpoint<{ id: string; judgeCorrect: boolean }>(
      file,
      (r) => r.id,
    );
    expect(done.size).toBe(2);
    expect(done.get('q2')?.judgeCorrect).toBe(true);
  });
});
