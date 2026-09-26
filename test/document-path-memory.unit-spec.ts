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

describe("MentionViaDocumentService puts the user among the participants (the user's own turn)", () => {
  it('a user-scoped turn with no speaker anchor is the user’s: episode speaker, internal meta, framing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const captured: Array<Record<string, unknown>> = [];
    const documents = {
      ingestDocument: jest.fn(async (_c: string, _dto: unknown, opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          doc: { id: 'source_document:d1' },
          runs: [],
          committed: { entityIds: ['knowledge_entity:u'], factIds: [], edgeIds: [] },
        };
      }),
    };
    const episodes = {
      captureTurn: jest.fn(async (_c: string, dto: Record<string, unknown>) => {
        captured.push(dto);
        return 'episode:1';
      }),
    };
    // The user's entity is named already — the memory's name is used.
    const users = {
      participants: jest.fn(async (_c: string, dto: Record<string, unknown>) => ({
        ...dto,
        knownEntities: [{ vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' }],
      })),
    };
    const svc = new MentionViaDocumentService(
      documents as never,
      episodes as never,
      undefined,
      undefined,
      users as never,
    );
    await svc.ingest('co', {
      text: 'I listed my apartment in Riga for sale today.',
      contextRef: { vertical: 'personal', conversationId: 'conv', messageId: 'm1' },
      userId: 'u42',
    } as never);
    // Normalised BEFORE the episode capture, so the L0 turn names its speaker.
    expect(captured[0]?.knownEntities).toEqual([
      { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' },
    ]);
    expect(calls[0]?.internal).toMatchObject({
      speakerName: 'Sasha',
      speakerRef: 'user:u42',
      knownNames: 'Sasha',
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
      // Earlier turns are the ones said before it (it may be read later).
      before: doc.occurredAt,
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

  it("frames the user's own turn when the speaker ref is the document's user", async () => {
    const extractCalls: unknown[] = [];
    const extractor = {
      modelId: () => 'm',
      vocabularyVersionHash: async () => 'v',
      extract: jest.fn(async (_t: string, _c: string, ctx: unknown) => {
        extractCalls.push(ctx);
        return { entities: [], facts: [], edges: [] };
      }),
    };
    const candidates = {
      createRun: async () => ({ created: true, runId: 'indexer_run:r' }),
      insertBatch: async () => ({ entities: 0, facts: 0, relations: 0 }),
      finalizeRun: async () => undefined,
    };
    const memory = { build: jest.fn(async () => undefined) };
    const svc = new IndexerRunService(extractor as never, candidates as never, memory as never);
    const own: StoredDocument = {
      ...doc,
      meta: { conversationId: 'conv', speakerName: 'Sasha', speakerRef: 'user:u1' },
    };
    await svc.runGeneral({ companyId: 'co', doc: own, chunks: [{ seq: 0, text: 't' }] as never });
    expect(extractCalls[0]).toEqual({ speakerName: 'Sasha', speakerIsUser: true });
    // Another user's ref (or a third party's) is a plain speaker.
    const other: StoredDocument = { ...own, meta: { ...own.meta, speakerRef: 'user:u2' } };
    await svc.runGeneral({ companyId: 'co', doc: other, chunks: [{ seq: 0, text: 't' }] as never });
    expect(extractCalls[1]).toEqual({ speakerName: 'Sasha' });
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
    // First person → the speaker's externalRef anchor; a third-party ref
    // carries no scope.
    expect(resolveCalls[1]?.hint).toEqual({
      vertical: 'chat',
      id: 'mike',
      role: 'speaker',
      name: 'Mike',
    });
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

  it("anchors the user's first person to the user's own reference, under the user's scope", async () => {
    const { svc, resolveCalls } = make();
    await svc.writeMerged({
      companyId: 'co',
      doc: { ...doc, meta: { speakerName: 'Sasha', speakerRef: 'user:u1' } },
      merge: {
        entities: [{ key: 'k1', name: 'I', type: 'staff', candidateIds: [] }],
        facts: [],
        relations: [],
        rejected: [],
      },
      factsToWrite: [],
      embeddings: [],
    });
    expect(resolveCalls[0]?.hint).toEqual({
      vertical: 'user',
      id: 'u1',
      role: 'speaker',
      name: 'Sasha',
      userId: 'u1',
    });
  });
});
