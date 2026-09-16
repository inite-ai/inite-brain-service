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

  it('calls a reasoning model without temperature and at low effort', async () => {
    // gpt-5.x rejects `temperature` with a 400 and bills hidden reasoning
    // against max_completion_tokens; the hand-rolled call that sat here
    // (temperature: 0, max_completion_tokens: 64) produced a 400 on one
    // model class and an empty message on the other — both "unsure".
    const { svc, openai } = make({ OPENAI_API_KEY: 'sk-test', ENTITY_JUDGE_MODEL: 'gpt-5.6-luna' });
    openai.chat.completions.create.mockResolvedValue(verdict('same'));
    expect(await svc.judge('a', 'b')).toBe('same');
    const params = openai.chat.completions.create.mock.calls[0][0];
    expect(params.model).toBe('gpt-5.6-luna');
    expect(params).not.toHaveProperty('temperature');
    expect(params.reasoning_effort).toBe('low');
    expect(params.max_completion_tokens).toBeGreaterThanOrEqual(512);
  });

  it('calls a deterministic model with temperature 0 and no effort field', async () => {
    const { svc, openai } = make({ OPENAI_API_KEY: 'sk-test', ENTITY_JUDGE_MODEL: 'gpt-4o' });
    openai.chat.completions.create.mockResolvedValue(verdict('same'));
    await svc.judge('a', 'b');
    const params = openai.chat.completions.create.mock.calls[0][0];
    expect(params.temperature).toBe(0);
    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params.max_completion_tokens).toBe(64);
  });

  it('defaults to the cheapest current-generation model, not the chat model', () => {
    const { svc } = make({ OPENAI_API_KEY: 'sk-test', OPENAI_CHAT_MODEL: 'gpt-4o-mini' });
    expect((svc as any).model).toBe('gpt-5.6-luna');
  });

  it('fetchTopFacts renders facts AND edges, with the empty sentinel', async () => {
    const { svc } = make({ OPENAI_API_KEY: 'sk-test' });
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          [
            { predicate: 'dob', object: '1990' },
            { predicate: 'city', object: 'NYC' },
          ],
          // The extractor files "works at Acme" as an EDGE in one language
          // and a fact in another; the judge has to see both shapes.
          [{ kind: 'works_at', other: 'Acme' }, { kind: 'knows' /* dangling: no other */ }],
        ])
        .mockResolvedValueOnce([[], []]),
    } as any;
    expect(await svc.fetchTopFacts(db, 'knowledge_entity:x')).toBe(
      '- dob: 1990\n- city: NYC\n- works_at: Acme',
    );
    expect(await svc.fetchTopFacts(db, 'knowledge_entity:y')).toBe('(no facts)');
  });

  it('fetchTopFacts does not fence facts on who said them', async () => {
    // knowledge_fact.userId is the SPEAKER, stamped on every fact a
    // per-user-scoped mention writes. Fencing on it left the judge with
    // "(no facts)" for every entity on such a tenant. The entity was
    // already fenced as tenant-global by the caller.
    const { svc } = make({ OPENAI_API_KEY: 'sk-test' });
    const db = { query: jest.fn().mockResolvedValueOnce([[], []]) } as any;
    await svc.fetchTopFacts(db, 'knowledge_entity:x');
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).not.toContain('userId IS NONE');
    expect(sql).toContain('FROM knowledge_edge');
  });
});
