/**
 * The document path (the one a stock deployment routes mentions through)
 * carries the memory contract end to end:
 *  - the mention wrapper threads the participants onto the internal meta;
 *  - IndexerRunService builds the extraction context off the stored
 *    document (participants, conversation, user, date) and passes the
 *    memory it read;
 *  - CommitWriterService files a pinned entity, anchors a participant to
 *    its externalRef, and passes eventTime/supersedes to the resolver.
 */
import { IndexerRunService } from '../src/documents/indexer-run.service';
import { CommitWriterService } from '../src/documents/commit-writer.service';
import { MentionViaDocumentService } from '../src/documents/mention-via-document.service';
import type { StoredDocument } from '../src/documents/document-store.service';

const doc: StoredDocument = {
  id: 'source_document:d1',
  kind: 'chat',
  contentHash: 'h',
  charLen: 10,
  chunkCount: 1,
  hasContent: true,
  vertical: 'chat',
  occurredAt: new Date('2026-09-16T11:00:00Z'),
  status: 'stored',
  userId: 'u1',
  meta: {
    conversationId: 'conv',
    messageId: 'm4',
    speakerName: 'Mike',
    speakerRef: 'chat:mike',
    addresseeName: 'Assistant',
    addresseeRef: 'chat:assistant',
    knownNames: ['Mike', 'Assistant', 'ledger-sync'].join('\u001f'),
  },
};

describe('MentionViaDocumentService threads the participants', () => {
  it('speaker/addressee names and refs ride the internal channel', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const documents = {
      ingestDocument: jest.fn(async (_c: string, _dto: unknown, opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          doc: { id: 'source_document:d1' },
          runs: [],
          committed: { entityIds: [], factIds: [], edgeIds: [] },
        };
      }),
    };
    const svc = new MentionViaDocumentService(documents as never);
    await svc.ingest('co', {
      text: 'hello',
      contextRef: { vertical: 'chat', conversationId: 'conv', messageId: 'm4' },
      knownEntities: [
        { vertical: 'chat', id: 'mike', role: 'speaker', name: 'Mike' },
        { vertical: 'chat', id: 'assistant', role: 'addressee', name: 'Assistant' },
        { vertical: 'chat', id: 'ledger-sync', name: 'ledger-sync' },
      ],
    } as never);
    expect(calls[0]?.internal).toMatchObject({
      conversationId: 'conv',
      messageId: 'm4',
      speakerName: 'Mike',
      speakerRef: 'chat:mike',
      addresseeName: 'Assistant',
      addresseeRef: 'chat:assistant',
      knownNames: ['Mike', 'Assistant', 'ledger-sync'].join('\u001f'),
    });
  });
});

describe('IndexerRunService.runGeneral builds the extraction context', () => {
  it('reads the memory off the document and hands the extractor the framing + memory', async () => {
    const built: unknown[] = [];
    const memoryCtx = {
      occurredAt: '2026-09-16T11:00:00.000Z',
      recentTurns: [],
      entities: [],
      facts: [],
      predicates: [],
    };
    const memory = {
      build: jest.fn(async (p: unknown) => {
        built.push(p);
        return memoryCtx;
      }),
    };
    const extractCalls: unknown[] = [];
    const extractor = {
      modelId: () => 'm',
      vocabularyVersionHash: async () => 'v',
      extract: jest.fn(async (text: string, companyId: string, ctx: unknown) => {
        extractCalls.push({ text, companyId, ctx });
        return { entities: [], facts: [], edges: [] };
      }),
    };
    const candidates = {
      createRun: async () => ({ created: true, runId: 'indexer_run:r' }),
      insertBatch: async () => ({ entities: 0, facts: 0, relations: 0 }),
      finalizeRun: async () => undefined,
    };
    const svc = new IndexerRunService(extractor as never, candidates as never, memory as never);
    await svc.runGeneral({ companyId: 'co', doc, chunks: [{ seq: 0, text: 'the turn' }] as never });
    expect(built[0]).toEqual({
      companyId: 'co',
      text: 'the turn',
      occurredAt: doc.occurredAt,
      conversationId: 'conv',
      messageId: 'm4',
      userId: 'u1',
      participants: ['Mike', 'Assistant', 'ledger-sync'],
    });
    expect(extractCalls[0]).toEqual({
      text: 'the turn',
      companyId: 'co',
      ctx: { speakerName: 'Mike', addresseeName: 'Assistant', memory: memoryCtx },
    });
  });
});

describe('CommitWriterService writes the contract', () => {
  function make() {
    const resolveCalls: Array<Record<string, unknown>> = [];
    const entities = {
      resolveOrCreateNamedEntity: jest.fn(
        async (p: { e: { name: string; known?: string }; hint?: unknown }) => {
          resolveCalls.push(p);
          return p.e.known ?? `knowledge_entity:${p.e.name}`;
        },
      ),
    };
    const factCalls: Array<Record<string, unknown>> = [];
    const factResolver = {
      resolve: jest.fn(async (_db: unknown, p: Record<string, unknown>) => {
        factCalls.push(p);
        return {
          result: { factId: 'knowledge_fact:new', outcome: 'INSERTED' },
          semantics: 'append_only',
        };
      }),
    };
    const surreal = {
      withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) => fn({}),
    };
    return {
      svc: new CommitWriterService(surreal as never, entities as never, factResolver as never),
      resolveCalls,
      factCalls,
    };
  }

  it('pins a known entity, anchors the speaker to its externalRef, passes timing and supersedes', async () => {
    const { svc, resolveCalls, factCalls } = make();
    await svc.writeMerged({
      companyId: 'co',
      doc,
      merge: {
        entities: [
          {
            key: 'k1',
            name: 'Rui',
            type: 'customer',
            known: 'knowledge_entity:rui',
            candidateIds: [],
          },
          { key: 'k2', name: 'I', type: 'staff', candidateIds: [] },
        ],
        facts: [],
        relations: [],
        rejected: [],
      },
      factsToWrite: [
        {
          entityKey: 'k1',
          predicate: 'monthly_budget',
          object: '2500',
          confidence: 0.9,
          eventTime: '2026-09-12',
          supersedes: ['knowledge_fact:old'],
          recorder: 'core',
          leaderId: 'c1',
          leaderChunkSeq: 0,
          mergedIds: [],
          contributors: [],
        },
      ],
      embeddings: [],
    });
    expect(resolveCalls[0]).toMatchObject({ e: { name: 'Rui', known: 'knowledge_entity:rui' } });
    expect(resolveCalls[0]?.hint).toBeUndefined();
    // First person → the speaker's externalRef anchor.
    expect(resolveCalls[1]?.hint).toMatchObject({ vertical: 'chat', id: 'mike', role: 'speaker' });
    expect(factCalls[0]).toMatchObject({
      entityId: 'knowledge_entity:rui',
      predicate: 'monthly_budget',
      supersedes: ['knowledge_fact:old'],
      objectMeta: { date: '2026-09-12' },
      userId: 'u1',
    });
    // An occurred day is the validity start.
    expect((factCalls[0]?.validFrom as Date).toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });
});
