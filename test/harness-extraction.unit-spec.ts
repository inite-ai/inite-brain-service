/**
 * Harness mode (#819, EXTRACTION_SOURCE=harness): the connected agent
 * extracts with its own model; the server spends no key on it.
 *
 *  - the work token binds tenant, documents, runs and expiry;
 *  - the background pass makes no model call (no triage, no read);
 *  - take hands out the prompt the server read would send — built by the
 *    same code, over the same rendered text and context;
 *  - submit runs the server's own post-processing (grounding included),
 *    stages on the claimed runs and commits in order.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ExtractorLlmService } from '../src/ai/extractor-llm.service';
import { ExtractorRunnerService } from '../src/ai/extractor-runner.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { ExtractionBatchService } from '../src/documents/extraction-batch.service';
import { extractionSource } from '../src/common/extraction-source';
import {
  mintWorkToken,
  verifyWorkToken,
  type ExtractionTokenPayload,
  type WorkTokenPayload,
} from '../src/common/harness-work-token';
import { verifiedWorkToken } from '../src/mcp/harness-work-tools';
import { ExtractionWorkService, tokenTtlMs } from '../src/documents/extraction-work.service';
import { IndexerRunService } from '../src/documents/indexer-run.service';
import type { StoredDocument } from '../src/documents/document-store.service';

const ENV = [
  'EXTRACTION_SOURCE',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'FORGET_HMAC_KEY',
  'EXTRACTION_CONVERSATION_SETTLE_SECONDS',
  'EXTRACTOR_DIALOGUE_PROFILE',
] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.FORGET_HMAC_KEY = 'harness-spec-key';
  // Read every waiting conversation at once (no settle wait).
  process.env.EXTRACTION_CONVERSATION_SETTLE_SECONDS = '0';
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const payload = (over: Partial<ExtractionTokenPayload> = {}): ExtractionTokenPayload => ({
  v: 2,
  t: 'extraction',
  c: 'co_a',
  d: ['document:1'],
  r: ['indexer_run:1'],
  h: 'vh',
  k: '',
  x: { e: [], m: [] },
  n: 'nonce',
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

describe('EXTRACTION_SOURCE', () => {
  it('is server unless it says harness', () => {
    expect(extractionSource({})).toBe('server');
    expect(extractionSource({ EXTRACTION_SOURCE: 'nonsense' })).toBe('server');
    expect(extractionSource({ EXTRACTION_SOURCE: ' Harness ' })).toBe('harness');
  });
});

describe('work token', () => {
  it('round-trips a signed payload', () => {
    const p = payload();
    expect(verifyWorkToken(mintWorkToken(p))).toEqual({ state: 'valid', payload: p });
  });

  it('refuses an edited payload or signature', () => {
    const token = mintWorkToken(payload());
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify(payload({ c: 'co_b' }))).toString('base64url');
    expect(verifyWorkToken(`${forged}.${sig}`).state).toBe('invalid');
    expect(verifyWorkToken(`${body}.${sig.slice(0, -2)}AA`).state).toBe('invalid');
    expect(verifyWorkToken('garbage').state).toBe('invalid');
    expect(verifyWorkToken(42).state).toBe('invalid');
  });

  it('refuses a token signed under another key', () => {
    const token = mintWorkToken(payload(), { FORGET_HMAC_KEY: 'other' });
    expect(verifyWorkToken(token).state).toBe('invalid');
  });

  it('expires', () => {
    const token = mintWorkToken(payload({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(verifyWorkToken(token).state).toBe('expired');
  });

  it('refuses a payload of an unknown version or kind, or missing its kind fields', () => {
    const forge = (p: object) => mintWorkToken(p as WorkTokenPayload);
    expect(verifyWorkToken(forge({ ...payload(), v: 1 })).state).toBe('invalid');
    expect(verifyWorkToken(forge({ ...payload(), t: 'nonsense' })).state).toBe('invalid');
    expect(verifyWorkToken(forge({ ...payload(), x: undefined })).state).toBe('invalid');
  });

  it('expires inside the run ledger stale window', () => {
    expect(tokenTtlMs()).toBe(29 * 60_000);
  });
});

describe('the background pass in harness mode', () => {
  it('makes no read and no triage call; documents stay pending', async () => {
    process.env.EXTRACTION_SOURCE = 'harness';
    const candidates = {
      listAwaitingRuns: jest.fn(async () => [
        { docId: 'document:1', arrivedAt: new Date(), priority: 0 },
      ]),
    };
    const runs = { runGeneral: jest.fn(), runGeneralGroup: jest.fn(), keepRaw: jest.fn() };
    const store = { getById: jest.fn(), getChunks: jest.fn() };
    const decisions = { enabled: jest.fn(() => true), decide: jest.fn() };
    const batch = new ExtractionBatchService(
      store as never,
      candidates as never,
      runs as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      decisions as never,
    );
    const out = await batch.runPass('co_a', { force: true });
    expect(out).toEqual({ read: 0, failed: 0, committed: 0, retry: 0 });
    expect(runs.runGeneral).not.toHaveBeenCalled();
    expect(runs.runGeneralGroup).not.toHaveBeenCalled();
    expect(store.getById).not.toHaveBeenCalled();
    expect(decisions.enabled).not.toHaveBeenCalled();
  });
});

describe('the prepared prompt is what the server read sends', () => {
  it('system prompt, user content and schema equal the extraction call', async () => {
    const llm = new ExtractorLlmService({
      get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'sk-test' : d),
      getOrThrow: () => 'sk-test',
    } as never);
    const create = jest.fn(async (_body: unknown) => ({
      choices: [{ message: { content: '{"entities":[],"clauses":[],"facts":[],"edges":[]}' } }],
    }));
    (llm as unknown as { openai: unknown }).openai = { chat: { completions: { create } } };
    const runner = new ExtractorRunnerService(llm, {} as never, {} as never);
    const snapshot = { versionHash: 'h', active: [] };
    const context = { speakerName: 'Ana', speakerIsUser: true };
    const trimmed = 'I moved to Porto last week.';
    const prepared = runner.prepare({ trimmed, snapshot, context });
    await llm.callLlm({
      trimmed,
      systemPrompt: llm.composeSystemPrompt(snapshot),
      contextPrefix: (
        await import('../src/ai/extractor-internals/prompts')
      ).buildConversationContext(context),
    });
    const body = create.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { schema: unknown } };
    };
    expect(body.messages).toEqual([
      { role: 'system', content: prepared.systemPrompt },
      { role: 'user', content: prepared.userContent },
    ]);
    expect(body.response_format.json_schema.schema).toEqual(prepared.schema);
    expect(prepared.userContent.endsWith(trimmed)).toBe(true);
  });
});

// ── take / submit over a mocked ledger ───────────────────────────────

const doc = (id: string, at: string, text: string): { doc: StoredDocument; text: string } => ({
  doc: {
    id,
    occurredAt: new Date(at),
    chunkCount: 1,
    meta: { conversationId: 'conv-1' },
  } as unknown as StoredDocument,
  text,
});

const DOCS = [
  doc('document:1', '2026-10-01T10:00:00Z', 'Alice lives in Lisbon.'),
  doc('document:2', '2026-10-01T10:01:00Z', 'She works at Initech.'),
];

function harness(opts: { runStatus?: string } = {}) {
  const byId = new Map(DOCS.map((d) => [d.doc.id, d]));
  const store = {
    getById: jest.fn(async (_c: string, id: string) => byId.get(id)?.doc ?? null),
    getChunks: jest.fn(async (_c: string, id: string) => [
      { seq: 0, text: byId.get(id)?.text ?? '', charStart: 0, charEnd: 0 },
    ]),
    setStatus: jest.fn(async () => undefined),
  };
  const runIds = new Map(DOCS.map((d, i) => [d.doc.id, `indexer_run:r${i + 1}`]));
  const candidates = {
    listAwaitingRuns: jest.fn(async () =>
      DOCS.map((d) => ({ docId: d.doc.id, arrivedAt: d.doc.occurredAt, priority: 0 })),
    ),
    createRun: jest.fn(async (_c: string, p: { docId: string }) => ({
      created: true,
      runId: runIds.get(p.docId) as string,
    })),
    getRun: jest.fn(async (_c: string, runId: string) => {
      const docId = [...runIds].find(([, r]) => r === runId)?.[0];
      return docId ? { runId, docId, status: opts.runStatus ?? 'running' } : null;
    }),
    insertBatch: jest.fn(async () => ({ entities: 1, facts: 1, relations: 0 })),
    finalizeRun: jest.fn(async () => undefined),
  };
  const memory = { build: jest.fn(async (): Promise<unknown> => undefined) };
  const extractor = {
    modelId: () => 'm',
    vocabularyVersionHash: jest.fn(async () => 'vh'),
    extractBackground: jest.fn(async () => ({ entities: [], facts: [], edges: [] })),
    prepareRead: jest.fn(async () => ({
      vocabularyHash: 'vh',
      systemPrompt: 'SYS',
      userContent: 'USER',
      schema: { type: 'object' },
    })),
    assembleRead: jest.fn(async () => ({
      entities: [{ name: 'Alice', type: 'person' }],
      facts: [{ entityIndex: 0, predicate: 'lives_in', valueSpan: 'Lisbon', confidence: 0.9 }],
      edges: [],
    })),
  };
  const runs = new IndexerRunService(extractor as never, candidates as never, memory as never);
  const batch = {
    commitInOrder: jest.fn(async (_c: string, docs: StoredDocument[]) => docs.length),
  };
  const work = new ExtractionWorkService(
    store as never,
    candidates as never,
    runs,
    extractor as never,
    batch as never,
  );
  return { work, runs, store, candidates, extractor, batch, memory };
}

describe('take', () => {
  it('claims the waiting group and prepares the read the server pass would make', async () => {
    const server = harness();
    await server.runs.runGeneralGroup({
      companyId: 'co_a',
      docs: DOCS.map((d) => d.doc),
      texts: new Map(DOCS.map((d) => [d.doc.id, d.text])),
      depth: 'single',
    });
    const serverCall = server.extractor.extractBackground.mock.calls[0] as unknown as [
      { text: string; context: unknown; passes: number },
    ];

    const h = harness();
    const taken = await h.work.take('co_a');
    expect(taken).toMatchObject({
      systemPrompt: 'SYS',
      userContent: 'USER',
      schema: { type: 'object' },
      kind: 'extraction',
      items: 2,
    });
    expect(h.candidates.createRun).toHaveBeenCalledTimes(2);
    const prepareCall = h.extractor.prepareRead.mock.calls[0] as unknown as [
      { text: string; context: unknown },
    ];
    expect(prepareCall[0].text).toBe(serverCall[0].text);
    expect(prepareCall[0].context).toEqual(serverCall[0].context);
    expect(serverCall[0].passes).toBe(1);
    const verdict = verifyWorkToken(taken?.token);
    expect(verdict.state).toBe('valid');
    if (verdict.state === 'valid') {
      expect(verdict.payload).toMatchObject({
        c: 'co_a',
        d: ['document:1', 'document:2'],
        r: ['indexer_run:r1', 'indexer_run:r2'],
        h: 'vh',
      });
    }
    expect(h.extractor.extractBackground).not.toHaveBeenCalled();
  });

  it('returns null when nothing is waiting', async () => {
    const h = harness();
    h.candidates.listAwaitingRuns.mockResolvedValueOnce([]);
    expect(await h.work.take('co_a')).toBeNull();
  });

  it('a tenant-global caller never takes a user document', async () => {
    const h = harness();
    h.store.getById.mockImplementation(async (_c: string, id: string) => ({
      ...(DOCS.find((d) => d.doc.id === id)?.doc as StoredDocument),
      userId: 'u-1',
    }));
    expect(await h.work.take('co_a')).toBeNull();
    expect(h.candidates.createRun).not.toHaveBeenCalled();
  });

  it('leaves documents another worker holds', async () => {
    const h = harness();
    h.candidates.createRun.mockResolvedValue({ created: false, runId: 'indexer_run:x' });
    expect(await h.work.take('co_a')).toBeNull();
  });
});

/** The verified payload of a token take handed out. */
function issued(token: string | undefined): ExtractionTokenPayload {
  const v = verifyWorkToken(token);
  if (v.state !== 'valid' || v.payload.t !== 'extraction')
    throw new Error('not an extraction token');
  return v.payload;
}

describe('submit', () => {
  it('assembles, stages on the claimed runs and commits in order', async () => {
    const h = harness();
    const taken = await h.work.take('co_a');
    const out = await h.work.submit('co_a', issued(taken?.token), { facts: [] });
    expect(out).toEqual({ documents: 2, facts: 1, entities: 1, edges: 0, committed: 2 });
    expect(h.extractor.assembleRead).toHaveBeenCalledTimes(1);
    expect(h.candidates.insertBatch).toHaveBeenCalled();
    const finalized = h.candidates.finalizeRun.mock.calls as unknown as Array<
      [string, { runId: string; status: string }]
    >;
    expect(finalized.map(([, p]) => [p.runId, p.status])).toEqual([
      ['indexer_run:r1', 'succeeded'],
      ['indexer_run:r2', 'succeeded'],
    ]);
    expect(h.batch.commitInOrder).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad token, another tenant and an expired token with 4xx', () => {
    expect(() => verifiedWorkToken('co_a', 'nope')).toThrow(BadRequestException);
    const foreign = mintWorkToken(payload({ c: 'co_b' }));
    expect(() => verifiedWorkToken('co_a', foreign)).toThrow(ForbiddenException);
    const expired = mintWorkToken(payload({ exp: Math.floor(Date.now() / 1000) - 5 }));
    expect(() => verifiedWorkToken('co_a', expired)).toThrow(BadRequestException);
    expect(verifiedWorkToken('co_a', mintWorkToken(payload())).t).toBe('extraction');
  });

  it('maps the reply handles by the ids the token carries, not a rebuilt memory', async () => {
    const h = harness();
    const memoryAt = (entities: string[], facts: string[]) => ({
      recentTurns: [],
      predicates: [],
      entities: entities.map((id, i) => ({ handle: `e${i + 1}`, id, name: id, type: 'other' })),
      facts: facts.map((id, i) => ({
        handle: `m${i + 1}`,
        id,
        entityHandle: 'e1',
        predicate: 'p',
        object: 'o',
      })),
    });
    h.memory.build.mockResolvedValueOnce(
      memoryAt(
        ['knowledge_entity:a', 'knowledge_entity:b'],
        ['knowledge_fact:1', 'knowledge_fact:2'],
      ) as never,
    );
    const taken = await h.work.take('co_a');
    expect(issued(taken?.token).x).toEqual({
      e: ['knowledge_entity:a', 'knowledge_entity:b'],
      m: ['knowledge_fact:1', 'knowledge_fact:2'],
    });
    // Another replica rebuilds the memory in another order.
    h.memory.build.mockResolvedValueOnce(
      memoryAt(
        ['knowledge_entity:b', 'knowledge_entity:a'],
        ['knowledge_fact:2', 'knowledge_fact:1'],
      ) as never,
    );
    await h.work.submit('co_a', issued(taken?.token), { facts: [] });
    const [args] = h.extractor.assembleRead.mock.calls[0] as unknown as [
      {
        context: {
          memory: {
            entities: Array<{ handle: string; id: string }>;
            facts: Array<{ handle: string; id: string }>;
          };
        };
      },
    ];
    expect(args.context.memory.entities.map((e) => [e.handle, e.id])).toEqual([
      ['e1', 'knowledge_entity:a'],
      ['e2', 'knowledge_entity:b'],
    ]);
    expect(args.context.memory.facts.map((f) => [f.handle, f.id])).toEqual([
      ['m1', 'knowledge_fact:1'],
      ['m2', 'knowledge_fact:2'],
    ]);
  });

  it('refuses a replay: runs no longer claimed', async () => {
    const h = harness({ runStatus: 'succeeded' });
    const taken = await h.work.take('co_a');
    await expect(h.work.submit('co_a', issued(taken?.token), {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.candidates.insertBatch).not.toHaveBeenCalled();
  });

  it('releases the runs when the vocabulary moved', async () => {
    const h = harness();
    const taken = await h.work.take('co_a');
    h.extractor.vocabularyVersionHash.mockResolvedValue('vh2');
    await expect(h.work.submit('co_a', issued(taken?.token), {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    const statuses = (
      h.candidates.finalizeRun.mock.calls as unknown as Array<[string, { status: string }]>
    ).map(([, p]) => p.status);
    expect(statuses).toEqual(['failed', 'failed']);
  });
});

describe('a submitted reply goes through the server post-processing', () => {
  it('drops a value the text does not hold (closed profile grounding)', async () => {
    const runner = new ExtractorRunnerService(
      {} as never,
      { persistPatterns: () => {} } as never,
      { applyPredicateRefinements: async () => {} } as never,
    );
    const registry = { getSnapshot: async () => ({ versionHash: 'h', active: [] }) };
    const extractor = new ExtractorService({} as never, registry as never, runner);
    const text = 'Alice lives in Lisbon.';
    const result = await extractor.assembleRead({
      text,
      companyId: 'co_a',
      rawJson: {
        clauses: [text],
        entities: [{ name: 'Alice', type: 'person', canonical: null, known: null }],
        facts: [
          {
            entityIndex: 0,
            clauseIndex: 0,
            predicate: 'lives_in',
            valueSpan: 'Lisbon',
            confidence: 0.9,
          },
          {
            entityIndex: 0,
            clauseIndex: 0,
            predicate: 'works_at',
            valueSpan: 'Globex Corporation',
            confidence: 0.9,
          },
        ],
        edges: [],
      },
    });
    const spans = result.facts.map((f) => f.valueSpan);
    expect(spans).not.toContain('Globex Corporation');
    expect(result.entities.map((e) => e.name)).toEqual(['Alice']);
  });
});
