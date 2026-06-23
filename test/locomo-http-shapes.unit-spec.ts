/**
 * Wire-shape coverage for the LoCoMo HTTP path.
 *
 * Without these tests the runner would happily POST a payload that
 * brain rejects with 400 — silent on the static type checker (the
 * production DTOs use class-validator, not TS interfaces). We pin
 * the exact JSON shapes here.
 *
 * - registerSpeaker → POST /v1/ingest/fact with the IngestFactDto
 *   shape: { entityRef, predicate, object, validFrom, source }.
 * - ingestMention   → POST /v1/ingest/mention with IngestMentionDto:
 *   { text, contextRef, emittedAt, knownEntities }.
 * - multiHop QA     → POST /v1/search/multi-hop with MultiHopDto:
 *   { query, maxHops, synthesize, synthesisGuardrails, asOf }.
 *
 * All using a mocked fetch — no real brain process.
 */
import {
  HttpBrainClient,
  EvalMultiHopResponse,
} from '../test/eval/http-brain-client';
import {
  createHttpIngestSink,
  createHttpQaAgent,
} from '../test/eval/locomo/http-agent';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function makeMockFetch(response: unknown): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyText = init?.body as string | undefined;
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: bodyText ? JSON.parse(bodyText) : {},
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn, calls };
}

describe('LoCoMo HTTP shapes', () => {
  it('registerSpeaker posts the IngestFactDto shape', async () => {
    const { fetch: mock, calls } = makeMockFetch({
      factId: 'kf:x',
      outcome: 'INSERTED',
    });
    const client = new HttpBrainClient({
      baseUrl: 'http://brain',
      apiKey: 'k',
      fetchImpl: mock,
    });
    const sink = createHttpIngestSink(client);
    await sink.registerSpeaker({
      entityId: 'conv_1__alice',
      name: 'Alice Smith',
      validFrom: '2023-05-01T12:00:00.000Z',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://brain/v1/ingest/fact');
    const body = calls[0].body;
    expect(body).toMatchObject({
      entityRef: { vertical: 'locomo', id: 'conv_1__alice' },
      predicate: 'name',
      object: 'Alice Smith',
      validFrom: '2023-05-01T12:00:00.000Z',
      confidence: 1,
    });
    // FactSource requires `vertical`; messageId / recorder optional but
    // we set them for source-trust grouping.
    expect(body.source).toMatchObject({ vertical: 'locomo' });
  });

  it('ingestMention posts the IngestMentionDto shape (NOT the old fact-style fields)', async () => {
    const { fetch: mock, calls } = makeMockFetch({
      extractedEntityIds: [],
      extractedFactIds: [],
    });
    const client = new HttpBrainClient({
      baseUrl: 'http://brain',
      apiKey: 'k',
      fetchImpl: mock,
    });
    const sink = createHttpIngestSink(client);
    await sink.ingestMention({
      speakerEntityId: 'conv_1__alice',
      text: 'I bought a cat last weekend.',
      validFrom: '2023-05-01T12:00:00.000Z',
      sourceMessageId: 'locomo:conv-1:D1:5',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://brain/v1/ingest/mention');
    const body = calls[0].body;
    // Required by IngestMentionDto.
    expect(body).toMatchObject({
      text: 'I bought a cat last weekend.',
      emittedAt: '2023-05-01T12:00:00.000Z',
    });
    expect(body.contextRef).toMatchObject({
      vertical: 'locomo',
      messageId: 'locomo:conv-1:D1:5',
      conversationId: 'locomo:conv-1',
    });
    expect(body.knownEntities).toEqual([
      { vertical: 'locomo', id: 'conv_1__alice', role: 'speaker' },
    ]);
    // Negative — the runner used to post these (wrong) fields. If they
    // ever re-appear, the test catches it before brain returns 400.
    expect(body).not.toHaveProperty('entityRef');
    expect(body).not.toHaveProperty('validFrom');
    expect(body).not.toHaveProperty('source');
  });

  it('multi-hop QA agent posts the MultiHopDto shape', async () => {
    const response: EvalMultiHopResponse = {
      isMultiHop: true,
      hops: [],
      finalEntityIds: [],
      finalHits: [],
      supportingFactIds: [],
      synthesis: {
        answer: 'Alice bought a cat in May 2023.',
        citations: [],
      },
    };
    const { fetch: mock, calls } = makeMockFetch(response);
    const client = new HttpBrainClient({
      baseUrl: 'http://brain',
      apiKey: 'k',
      fetchImpl: mock,
    });
    const agent = createHttpQaAgent(client, { useMultiHop: true });
    const answer = await agent.answer({
      companyId: 'ignored',
      question: 'What did Alice buy in May?',
      asOf: '2023-06-01T00:00:00.000Z',
    });
    expect(answer).toBe('Alice bought a cat in May 2023.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://brain/v1/search/multi-hop');
    expect(calls[0].body).toMatchObject({
      query: 'What did Alice buy in May?',
      maxHops: 3,
      synthesize: true,
      synthesisGuardrails: 'lenient',
      asOf: '2023-06-01T00:00:00.000Z',
    });
  });

  it('falls back to /v1/synthesize when useMultiHop=false', async () => {
    const { fetch: mock, calls } = makeMockFetch({
      answer: 'no information available',
      citations: [],
      results: [],
    });
    const client = new HttpBrainClient({
      baseUrl: 'http://brain',
      apiKey: 'k',
      fetchImpl: mock,
    });
    const agent = createHttpQaAgent(client, { useMultiHop: false });
    const answer = await agent.answer({
      companyId: 'ignored',
      question: 'unanswerable adversarial',
    });
    expect(answer).toBe('no information available');
    expect(calls[0].url).toBe('http://brain/v1/synthesize');
  });
});
