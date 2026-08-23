/**
 * Phase 4.C e2e — answerLang policy reaches the generator prompt.
 *
 * Closes the P0 gap: the language-detector unit-spec covers
 * detection, but no test asserted that the language instruction is
 * actually rendered into the synthesize user message.
 *
 * Two cases:
 *   1. Explicit dto.answerLang wins over the query-language detector.
 *   2. Detector picks the answer language from the query when the
 *      DTO omits answerLang.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';

describe('Phase 4.C e2e — answerLang in generator prompt', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'lang_pin_tenant' },
      predicate: 'status',
      object: 'engineer',
      validFrom: '2026-04-01',
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('renders explicit answerLang into the prompt', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'engineer', answerLang: 'ru' });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThan(0);
    expect(state.calls[0]!.user).toContain('write your answer in ru');
  });

  it('falls back to detected query language when DTO omits answerLang', async () => {
    const state = mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'ok', citedFactIds: [] }),
      JSON.stringify({ verdict: 'supported', unsupportedClaims: [] }),
    ]);
    const res = await f.http
      .post('/v1/synthesize')
      .set(auth())
      .send({ query: 'кто здесь технический директор' });
    expect(res.status).toBe(201);
    expect(state.calls.length).toBeGreaterThan(0);
    expect(state.calls[0]!.user).toContain('write your answer in ru');
  });
});
