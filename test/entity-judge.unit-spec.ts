/**
 * EntityJudgeService — the shared same/different/unsure verdict (unit).
 *
 * Pins the contract both dreams dedup and inline resolution rely on:
 *   - no OpenAI key → unavailable, judge degrades to "unsure"
 *   - valid verdict parsed through
 *   - empty / malformed / thrown response → "unsure" (never throws)
 *   - fetchTopFacts renders facts (or the empty sentinel)
 */
import { EntityJudgeService } from '../src/ai/entity-judge.service';

function make(cfg: Record<string, string>) {
  const config = {
    get: (k: string, d?: string) => (k in cfg ? cfg[k] : d),
  } as any;
  const svc = new EntityJudgeService(config);
  const openai = { chat: { completions: { create: jest.fn() } } };
  (svc as any).openai = cfg.OPENAI_API_KEY ? openai : undefined;
  return { svc, openai };
}

const verdict = (v: string) => ({
  choices: [{ message: { content: JSON.stringify({ verdict: v }) } }],
});

describe('EntityJudgeService', () => {
  it('is unavailable and returns "unsure" without an API key', async () => {
    const { svc } = make({});
    expect(svc.isAvailable()).toBe(false);
    expect(await svc.judge('a', 'b')).toBe('unsure');
  });

  it('parses a valid verdict through', async () => {
    const { svc, openai } = make({ OPENAI_API_KEY: 'sk-test' });
    expect(svc.isAvailable()).toBe(true);
    openai.chat.completions.create.mockResolvedValue(verdict('same'));
    expect(await svc.judge('A facts', 'B facts', { cosine: 0.91 })).toBe('same');
    // cosine hint reaches the prompt.
    const arg = openai.chat.completions.create.mock.calls[0][0];
    expect(JSON.stringify(arg.messages)).toContain('0.910');
  });

  it('returns "unsure" on empty content', async () => {
    const { svc, openai } = make({ OPENAI_API_KEY: 'sk-test' });
    openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '' } }],
    });
    expect(await svc.judge('a', 'b')).toBe('unsure');
  });

  it('returns "unsure" when the call throws (never propagates)', async () => {
    const { svc, openai } = make({ OPENAI_API_KEY: 'sk-test' });
    openai.chat.completions.create.mockRejectedValue(new Error('429'));
    expect(await svc.judge('a', 'b')).toBe('unsure');
  });

  it('fetchTopFacts renders lines, with the empty sentinel', async () => {
    const { svc } = make({ OPENAI_API_KEY: 'sk-test' });
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          [{ predicate: 'dob', object: '1990' }, { predicate: 'city', object: 'NYC' }],
        ])
        .mockResolvedValueOnce([[]]),
    } as any;
    expect(await svc.fetchTopFacts(db, 'knowledge_entity:x')).toBe(
      '- dob: 1990\n- city: NYC',
    );
    expect(await svc.fetchTopFacts(db, 'knowledge_entity:y')).toBe('(no facts)');
  });
});
