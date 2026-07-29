/**
 * Coverage for the shared world-axis eval harness (test/eval/harness/):
 * flag parsing, pool bounds, report aggregation, and — via a recorded
 * fake fetch — the driver's protocol invariants that paid runs depend
 * on: speaker naming mirrors the deriver, emittedAt sub-session
 * chunking, abstention guardrails, dated retrieval, checkpoint resume.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseFlags } from '../test/eval/harness/flags';
import { runPool } from '../test/eval/harness/pool';
import {
  buildAxisReport,
  estimateHaystackTokens,
} from '../test/eval/harness/report';
import {
  runWorlds,
  speakerEntityName,
  emittedAtIso,
  TURN_CHAR_CAP,
} from '../test/eval/harness/driver';
import { EvalScore, EvalWorld } from '../test/eval/harness/types';
import { appendCheckpoint } from '../test/eval/checkpoint';

describe('parseFlags', () => {
  const spec = {
    '--name': { key: 'name', type: 'string' },
    '--n': { key: 'n', type: 'int' },
    '--on': { key: 'on', type: 'bool' },
    '--list': { key: 'list', type: 'list' },
  } as const;

  it('parses each type over defaults', () => {
    const args = parseFlags(
      ['--name', 'x', '--n', '7', '--on', '--list', 'a,b'],
      spec,
      { name: '', n: 1, on: false, list: [] as string[] },
    );
    expect(args).toEqual({ name: 'x', n: 7, on: true, list: ['a', 'b'] });
  });

  it('throws on unknown flags and malformed ints', () => {
    expect(() => parseFlags(['--typo'], spec, {})).toThrow('unknown flag');
    expect(() => parseFlags(['--n', 'NaN'], spec, {})).toThrow('integer');
    expect(() => parseFlags(['--name'], spec, {})).toThrow('needs a value');
  });
});

describe('runPool', () => {
  it('processes every item with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool(3, [...Array(10).keys()], async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item);
      active -= 1;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('buildAxisReport', () => {
  const score = (over: Partial<EvalScore>): EvalScore => ({
    questionId: 'q',
    group: 'g',
    question: '?',
    gold: 'a',
    prediction: 'a',
    isAbstention: false,
    abstained: false,
    ...over,
  });

  it('separates abstention denominator and averages tokens', () => {
    const report = buildAxisReport([
      score({ questionId: 'q1', judgeCorrect: true, promptTokens: 100 }),
      score({ questionId: 'q2', judgeCorrect: false, promptTokens: 300 }),
      score({ questionId: 'q3', group: 'h', errored: 'boom' }),
      score({ questionId: 'q4', isAbstention: true, abstained: true }),
    ]);
    expect(report.judgeAccuracy).toBe(0.5);
    expect(report.judgedN).toBe(2);
    expect(report.abstention).toEqual({ n: 1, abstainedRate: 1 });
    expect(report.avgPromptTokens).toBe(200);
    expect(report.errored).toBe(1);
    expect(report.byGroup.map((g) => g.group).sort()).toEqual(['g', 'h']);
  });
});

describe('driver helpers', () => {
  it('mirrors the deriver speaker slug (suffix after ":", "-"→"_")', () => {
    expect(speakerEntityName('beam:100k-1', 'user')).toBe('100k_1__user');
    expect(speakerEntityName('lme:abc_def', 'assistant')).toBe(
      'abc_def__assistant',
    );
  });

  it('schedules turns 30s apart, jumping past the gap per chunk', () => {
    const base = Date.parse('2024-03-15T09:00:00.000Z');
    expect(emittedAtIso(base, 1)).toBe('2024-03-15T09:00:30.000Z');
    // turn 20 with chunkTurns=20 → second sub-session, +2h from base
    expect(emittedAtIso(base, 20, 20)).toBe('2024-03-15T11:00:00.000Z');
    expect(emittedAtIso(base, 21, 20)).toBe('2024-03-15T11:00:30.000Z');
  });
});

describe('runWorlds', () => {
  const world: EvalWorld = {
    tenant: 't1',
    conversationRef: 'lme:q-1',
    vertical: 'lme',
    sessions: [
      {
        sessionId: 's0',
        dateIso: '2023-05-20T02:21:00.000Z',
        turns: [
          { role: 'user', content: 'x'.repeat(TURN_CHAR_CAP + 100) },
          { role: 'assistant', content: 'short' },
        ],
      },
    ],
    questions: [
      {
        id: 'q-1',
        group: 'temporal-reasoning',
        question: 'when?',
        gold: 'May 2023',
        isAbstention: true,
        askedAtIso: '2023-06-01T00:00:00.000Z',
      },
    ],
  };

  interface RecordedCall {
    url: string;
    body: Record<string, any>;
  }

  function fakeFetch(calls: RecordedCall[]): typeof fetch {
    return (async (url: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ url: String(url), body });
      const payload = String(url).includes('multi-hop')
        ? { synthesis: { answer: 'no information about that', tokenUsage: { promptTokens: 42 } } }
        : { propositions: 1, segments: 1 };
      return {
        ok: true,
        json: async () => payload,
      } as Response;
    }) as typeof fetch;
  }

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('ingests with protocol invariants and scores abstention', async () => {
    const calls: RecordedCall[] = [];
    global.fetch = fakeFetch(calls);
    const { scores } = await runWorlds('lme', [world], {
      brainUrl: 'http://brain',
      apiKey: 'k',
      derivedVersion: 'wd-v2',
      concurrency: 1,
      skipIngest: false,
      log: () => undefined,
    });

    const mentions = calls.filter((c) => c.url.includes('/v1/ingest/mention'));
    expect(mentions).toHaveLength(2);
    expect(mentions[0].body.text).toHaveLength(TURN_CHAR_CAP); // cap applied
    expect(mentions[0].body.emittedAt).toBe('2023-05-20T02:21:00.000Z');
    expect(mentions[1].body.emittedAt).toBe('2023-05-20T02:21:30.000Z');
    expect(mentions[0].body.knownEntities[0].name).toBe('q_1__user');

    const derive = calls.find((c) => c.url.includes('/maintenance/derive'));
    expect(derive?.body).toEqual({ version: 'wd-v2', force: true });

    const qa = calls.find((c) => c.url.includes('multi-hop'));
    expect(qa?.body.synthesisGuardrails).toBe('lenient'); // abstention
    expect(qa?.body.asOf).toBe('2023-06-01T00:00:00.000Z');

    expect(scores).toHaveLength(1);
    expect(scores[0].abstained).toBe(true);
    expect(scores[0].promptTokens).toBe(42);
  });

  it('skips fully checkpointed worlds without any HTTP calls', async () => {
    const ckpt = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'harness-')),
      'run.jsonl',
    );
    await appendCheckpoint(ckpt, {
      questionId: 'q-1',
      group: 'temporal-reasoning',
      question: 'when?',
      gold: 'May 2023',
      prediction: 'May 2023',
      isAbstention: false,
      abstained: false,
      judgeCorrect: true,
    });
    const calls: RecordedCall[] = [];
    global.fetch = fakeFetch(calls);
    const { scores, checkpointed } = await runWorlds('lme', [world], {
      brainUrl: 'http://brain',
      apiKey: 'k',
      derivedVersion: 'wd-v2',
      concurrency: 1,
      skipIngest: false,
      resume: ckpt,
      log: () => undefined,
    });
    expect(calls).toHaveLength(0);
    expect(checkpointed).toBe(1);
    expect(scores[0].judgeCorrect).toBe(true);
  });
});

describe('estimateHaystackTokens', () => {
  it('approximates chars/4 across worlds', () => {
    const worlds = [
      {
        tenant: 't',
        conversationRef: 'v:1',
        vertical: 'v',
        questions: [],
        sessions: [
          {
            sessionId: 's',
            dateIso: '2024-01-01T00:00:00.000Z',
            turns: [{ role: 'user', content: 'x'.repeat(400) }],
          },
        ],
      },
    ];
    expect(estimateHaystackTokens(worlds)).toBe(100);
  });
});
