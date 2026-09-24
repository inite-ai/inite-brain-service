import { ConfigService } from '@nestjs/config';
import { JevClient } from '../src/ai/decisions/jev.client';

/**
 * The decision client's job is to be BORING: one endpoint, a retry policy that
 * distinguishes "ask again" from "you asked wrong", and a shape check strict
 * enough that a half-filled answer map can never reach a lane as a verdict.
 */
const cfg = (values: Record<string, string>): ConfigService =>
  ({ get: (k: string, fb?: string) => values[k] ?? fb }) as unknown as ConfigService;

const withKey = (extra: Record<string, string> = {}) =>
  new JevClient(cfg({ TYPESAFE_API_KEY: 'ts_test', TYPESAFE_MAX_RETRIES: '2', ...extra }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, text = '') => ({ ok: false, status, text: async () => text });

const ask = { state: 'x', questions: { q: { type: 'noul' as const, instructions: 'true?' } } };

describe('jev client', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('is unavailable without a key, and never calls out', async () => {
    const c = new JevClient(cfg({}));
    expect(c.available()).toBe(false);
    await expect(c.decide(ask, 'verifier')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing when the question map is empty', async () => {
    await expect(withKey().decide({ state: 'x', questions: {} }, 'verifier')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses the three answer shapes and normalises usage', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        model: 'jev-1.13.0',
        answers: {
          a: { type: 'noul', noul: 0.95 },
          b: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.88 },
            confidence: 0.81,
          },
          c: {
            type: 'score',
            score: 1.45,
            legend: { '0': 'Calm' },
            probabilities: { '1': 0.8 },
            confidence: 0.75,
          },
        },
        usage: { input_tokens: 350, output_tokens: 45 },
      }),
    );
    const res = await withKey().decide(
      {
        state: 'x',
        questions: {
          a: { type: 'noul', instructions: '?' },
          b: { type: 'choice', instructions: '?', criteria: { billing: 'x', technical: 'y' } },
          c: { type: 'score', instructions: '?', criteria: ['Calm', 'Angry'] },
        },
      },
      'chat_router',
    );
    expect(res?.model).toBe('jev-1.13.0');
    expect(res?.answers['a']).toEqual({ type: 'noul', noul: 0.95 });
    expect(res?.usage).toEqual({ inputTokens: 350, outputTokens: 45 });
  });

  it('a missing answer is not a verdict — the whole response is discarded', async () => {
    fetchMock.mockResolvedValueOnce(ok({ model: 'jev', answers: {}, usage: {} }));
    await expect(withKey().decide(ask, 'verifier')).resolves.toBeNull();
  });

  it('a wrong-shaped answer is discarded too', async () => {
    fetchMock.mockResolvedValueOnce(ok({ answers: { q: { type: 'noul', noul: 'very' } } }));
    await expect(withKey().decide(ask, 'verifier')).resolves.toBeNull();
  });

  it('retries a 429 and returns the answer that follows', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(429, 'slow down'))
      .mockResolvedValueOnce(ok({ answers: { q: { type: 'noul', noul: 0.2 } }, usage: {} }));
    const res = await withKey().decide(ask, 'verifier');
    expect(res?.answers['q']).toEqual({ type: 'noul', noul: 0.2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 529 overload as well', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(529))
      .mockResolvedValueOnce(ok({ answers: { q: { type: 'noul', noul: 0.9 } }, usage: {} }));
    await expect(withKey().decide(ask, 'verifier')).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a rejected key or a malformed request', async () => {
    fetchMock.mockResolvedValue(fail(422, 'bad question'));
    await expect(withKey().decide(ask, 'verifier')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and answers null, never throws', async () => {
    fetchMock.mockResolvedValue(fail(429));
    await expect(withKey().decide(ask, 'verifier')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + TYPESAFE_MAX_RETRIES
  });

  it('routes through OpenRouter when the base says so, and keeps its cost', async () => {
    // OpenRouter proxies the same Decisions protocol and bills it to that
    // account — one key instead of two — and adds `usage.cost`, which is the
    // real money a decision spent rather than an arithmetic reconstruction.
    fetchMock.mockResolvedValueOnce(
      ok({
        model: 'typesafe/jev-1.13',
        answers: { q: { type: 'noul', noul: 0.77 } },
        usage: { input_tokens: 300, output_tokens: 12, cost: 0.0000126 },
        provider: 'TypeSafe',
      }),
    );
    const res = await withKey({ TYPESAFE_BASE_URL: 'https://openrouter.ai/api' }).decide(
      ask,
      'entity_judge',
    );
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/systemone');
    expect(res?.usage).toEqual({ inputTokens: 300, outputTokens: 12, cost: 0.0000126 });
  });

  it('sends the model, the state and the questions to /v1/systemone', async () => {
    fetchMock.mockResolvedValueOnce(ok({ answers: { q: { type: 'noul', noul: 0.5 } }, usage: {} }));
    await withKey({ TYPESAFE_MODEL: 'jev-1.13.0' }).decide(ask, 'verifier');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ model: 'jev-1.13.0', state: 'x' });
    expect(body.questions.q.type).toBe('noul');
  });
});
