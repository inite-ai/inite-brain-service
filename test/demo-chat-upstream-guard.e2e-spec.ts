/**
 * Phase: prod 500 → 503 graceful degrade.
 *
 * The demo /v1/admin/demo/chat endpoint was returning a raw 500 when
 * any LLM call deep in the pipeline (chat-router, extractor, reranker,
 * synthesize) hit an OpenAI fetch failure such as
 * ERR_STREAM_PREMATURE_CLOSE. The right behaviour is to surface the
 * transient upstream outage as 503 with a retry hint, so the chat UI
 * can back off and replay instead of showing the operator a generic
 * internal-server-error.
 *
 * Two cases:
 *   1. Happy path — the controller still returns 200/201 with the
 *      usual { route, ... } payload.
 *   2. Upstream failure inside chatRouter — caller-facing response is
 *      503 with reason="upstream_llm_unavailable", detail carrying the
 *      original error message, retryAfterMs >= 0.
 *
 * We exercise the failure path by stubbing the ChatRouterService.route
 * method on the live app to throw an ERR_STREAM_PREMATURE_CLOSE
 * Error — same error shape the real OpenAI fetch raises in prod.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { ChatRouterService } from '../src/admin/chat-router.service';

describe('demo-chat upstream guard', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'demo_live' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('returns 200/201 on the happy path', async () => {
    const r = await f.http
      .post('/v1/admin/demo/chat')
      .set(auth())
      .send({ message: 'who is the CEO of Acme' });
    expect([200, 201]).toContain(r.status);
  });

  it('returns 503 with retry hint when an OpenAI fetch fails', async () => {
    const router = f.app.get(ChatRouterService);
    const original = router.route.bind(router);
    const fakeErr = Object.assign(
      new Error(
        'Invalid response body while trying to fetch https://api.openai.com/v1/chat/completions: Premature close',
      ),
      { code: 'ERR_STREAM_PREMATURE_CLOSE' },
    );
    (router as unknown as { route: () => Promise<unknown> }).route = () => {
      return Promise.reject(fakeErr);
    };
    try {
      const r = await f.http
        .post('/v1/admin/demo/chat')
        .set(auth())
        .send({ message: 'who runs engineering at Acme' });
      expect(r.status).toBe(503);
      expect(r.body.message?.reason ?? r.body.reason).toBe('upstream_llm_unavailable');
      const detail = r.body.message?.detail ?? r.body.detail;
      expect(detail).toContain('Premature close');
      const retryAfter = r.body.message?.retryAfterMs ?? r.body.retryAfterMs;
      expect(typeof retryAfter).toBe('number');
      expect(retryAfter).toBeGreaterThanOrEqual(0);
    } finally {
      (router as unknown as { route: typeof original }).route = original;
    }
  });

  it('still surfaces a BadRequest (typed Nest exception) without 503-wrapping', async () => {
    const r = await f.http.post('/v1/admin/demo/chat').set(auth()).send({ message: '   ' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('message is required');
  });
});
