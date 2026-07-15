import { createHmac } from 'node:crypto';
import { IndexerWebhookService } from '../src/documents/indexer-webhook.service';

/**
 * Webhook push is a best-effort HINT: signed correctly, retried briefly,
 * breaker-latched per URL, and NEVER observable as a failure by the
 * ingest path. These specs pin exactly that contract with a stubbed
 * fetch and a hand-rolled surreal (house style).
 */
describe('IndexerWebhookService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let secretRow: { webhookSecret?: string } | undefined;

  const surreal = {
    withCompany: async (_c: string, fn: (db: unknown) => unknown) =>
      fn({ query: async () => [[secretRow]] }),
  } as any;

  const event = {
    companyId: 'co_hook',
    documentId: 'source_document:doc1',
    packId: 'hook_pack',
    packVersion: '1.0.0',
    callbackUrl: 'https://indexer.example/hook',
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    secretRow = { webhookSecret: 'shhh-secret' };
    process.env.INDEXER_WEBHOOK_RETRY_BASE_MS = '1';
    delete process.env.INDEXER_WEBHOOK_PUSH_ENABLED;
  });

  afterAll(() => {
    global.fetch = realFetch;
    delete process.env.INDEXER_WEBHOOK_RETRY_BASE_MS;
    delete process.env.INDEXER_WEBHOOK_PUSH_ENABLED;
  });

  it('delivers a correctly signed work_available event', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(event.callbackUrl);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: 'work_available',
      documentId: event.documentId,
      packId: event.packId,
      packVersion: event.packVersion,
    });
    const expected = createHmac('sha256', 'shhh-secret')
      .update(init.body)
      .digest('hex');
    expect(init.headers['x-brain-signature']).toBe(`sha256=${expected}`);
    expect(init.headers['x-brain-event']).toBe('work_available');
  });

  it('retries a 5xx and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('latches the per-URL breaker after exhausted retries', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockClear();
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).not.toHaveBeenCalled(); // breaker skips
  });

  it('treats a 4xx as a rejection: one attempt, breaker latched', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 410 });
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips silently when the install has no webhook secret', async () => {
    secretRow = {};
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors the kill switch', async () => {
    process.env.INDEXER_WEBHOOK_PUSH_ENABLED = '0';
    const svc = new IndexerWebhookService(surreal);
    await svc.notifyWorkAvailable(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws into the caller, even when the secret lookup dies', async () => {
    const broken = {
      withCompany: async () => {
        throw new Error('db down');
      },
    } as any;
    const svc = new IndexerWebhookService(broken);
    await expect(svc.notifyWorkAvailable(event)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
