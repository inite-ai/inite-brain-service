/**
 * The direct mention path and the user's own turn (participants.ts):
 *  - MentionIngestService normalises the participants right after the
 *    scope pin, so the episode capture, the extraction and the persist
 *    stage all see the user as the speaker;
 *  - MentionExtractionService frames the user's own turn for the
 *    extractor (speakerName + speakerIsUser) and reads the memory with
 *    the user among the participants;
 *  - MentionPersistService anchors the extractor's "I" to the user's
 *    own reference, carrying the user's scope into the resolver.
 */
import { MentionIngestService } from '../src/ingest/mention-ingest.service';
import { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import { MentionPersistService } from '../src/ingest/mention-persist.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import { runWithRequestContext } from '../src/common/request-context';

const turn = {
  text: 'I listed my apartment in Riga for sale today.',
  contextRef: { vertical: 'personal', conversationId: 'c1', messageId: 'm1' },
  emittedAt: '2026-08-07T14:00:00.000Z',
  userId: 'u42',
} as unknown as IngestMentionDto;

const userSpeaker = { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' };

describe('MentionIngestService — the user among the participants', () => {
  it('normalises once at the entry; capture, extraction and persist read the same dto', async () => {
    const seen: Record<string, IngestMentionDto | undefined> = {};
    const extraction = {
      prepare: async (_c: string, dto: IngestMentionDto) => {
        seen.prepare = dto;
        return {
          skip: null,
          extraction: { entities: [], facts: [], edges: [] },
          source: { vertical: 'personal', recorder: 'r' },
          factEmbeddings: [],
        };
      },
    };
    const persist = {
      persistAll: async (p: { dto: IngestMentionDto }) => {
        seen.persist = p.dto;
        return { extractedEntityIds: [], extractedFactIds: [], extractedEdgeIds: [] };
      },
    };
    const episodes = {
      captureTurn: async (_c: string, dto: IngestMentionDto) => {
        seen.capture = dto;
        return 'episode:1';
      },
    };
    const users = {
      participants: jest.fn(async (_c: string, dto: IngestMentionDto) => ({
        ...dto,
        knownEntities: [userSpeaker],
      })),
    };
    const svc = new MentionIngestService(
      extraction as never,
      persist as never,
      undefined,
      episodes as never,
      undefined,
      undefined,
      users as never,
    );
    await runWithRequestContext({ correlationId: 't' }, () => svc.ingestMention('co', turn));
    expect(users.participants).toHaveBeenCalledTimes(1);
    for (const stage of ['capture', 'prepare', 'persist'] as const) {
      expect(seen[stage]?.knownEntities).toEqual([userSpeaker]);
      expect(seen[stage]?.userId).toBe('u42');
    }
  });
});

describe("MentionExtractionService — framing the user's own turn", () => {
  it('tells the extractor the speaker is the user and reads the memory with them among the participants', async () => {
    const contexts: unknown[] = [];
    const extractor = {
      extract: async (_t: string, _c: string, ctx: unknown) => {
        contexts.push(ctx);
        return { entities: [{ name: 'Sasha', type: 'customer' }], facts: [], edges: [] };
      },
      modelId: () => 'm',
    };
    const factEmbedding = { embedMany: async (texts: string[]) => texts.map(() => [0]) };
    const built: Array<Record<string, unknown>> = [];
    const memory = {
      build: async (p: Record<string, unknown>) => {
        built.push(p);
        return undefined;
      },
    };
    const svc = new MentionExtractionService(
      extractor as never,
      factEmbedding as never,
      memory as never,
    );
    await svc.prepare('co', { ...turn, knownEntities: [userSpeaker] });
    expect(contexts[0]).toEqual({ speakerName: 'Sasha', speakerIsUser: true });
    expect(built[0]).toMatchObject({ userId: 'u42', participants: ['Sasha'] });
    // A third-party speaker is framed as a plain speaker.
    await svc.prepare('co', {
      ...turn,
      knownEntities: [{ vertical: 'crm', id: 'ana', role: 'speaker', name: 'Ana' }],
    });
    expect(contexts[1]).toEqual({ speakerName: 'Ana' });
  });
});

describe("MentionPersistService — the user's first person lands on the user's own entity", () => {
  it("hints the extractor's 'I' with the user's reference under the user's scope", async () => {
    const hints: unknown[] = [];
    const entities = {
      resolveOrCreateNamedEntity: async (p: { e: { name: string }; hint?: unknown }) => {
        hints.push(p.hint);
        return `knowledge_entity:${p.e.name}`;
      },
    };
    const factResolver = { resolve: async () => ({ result: { factId: null, outcome: null } }) };
    const surreal = {
      withCompany: async (_c: string, fn: (db: unknown) => Promise<unknown>) => fn({}),
    };
    const svc = new MentionPersistService(
      surreal as never,
      entities as never,
      factResolver as never,
    );
    await svc.persistAll({
      companyId: 'co',
      dto: { ...turn, knownEntities: [userSpeaker] },
      extraction: {
        entities: [
          { name: 'I', type: 'customer' },
          { name: 'Riga', type: 'location' },
        ],
        facts: [],
        edges: [],
      } as never,
      source: { vertical: 'personal', recorder: 'r' },
      factEmbeddings: [],
    });
    expect(hints).toEqual([{ ...userSpeaker, userId: 'u42' }, undefined]);
  });
});
