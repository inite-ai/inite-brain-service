import { ForbiddenException } from '@nestjs/common';
import { MentionIngestService } from '../src/ingest/mention-ingest.service';
import type { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import type { MentionPersistService } from '../src/ingest/mention-persist.service';
import type { EpisodeStoreService } from '../src/ingest/episode-store.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import { runWithRequestContext } from '../src/common/request-context';

/**
 * Audit 2026-08-21 P0 — the mention path lost per-user scope: a
 * user-bound token with brain:write wrote episodes and extracted facts
 * tenant-global, readable by every other user of the tenant. The pin
 * now happens at the MentionIngestService entry (same seam as
 * fact-ingest / search / synthesize) and the pinned value must reach
 * BOTH the episode capture and the persist stage. Matrix: M2M with and
 * without an assertion, user token defaulting, user token mismatch.
 */

const baseDto = {
  text: 'I moved to Lisbon last spring',
  contextRef: { vertical: 'chat', conversationId: 'c1', messageId: 'm1' },
  emittedAt: '2026-08-01T10:00:00.000Z',
} as unknown as IngestMentionDto;

function makeService() {
  const captured: IngestMentionDto[] = [];
  const persisted: IngestMentionDto[] = [];
  const extraction = {
    prepare: async () => ({
      skip: undefined,
      extraction: { entities: [], facts: [] },
      source: { vertical: 'chat' },
      factEmbeddings: [],
    }),
  } as unknown as MentionExtractionService;
  const persist = {
    persistAll: async (p: { dto: IngestMentionDto }) => {
      persisted.push(p.dto);
      return {
        extractedEntityIds: [],
        extractedFactIds: [],
        extractedEdgeIds: [],
      };
    },
  } as unknown as MentionPersistService;
  const episodes = {
    captureTurn: async (_co: string, dto: IngestMentionDto) => {
      captured.push(dto);
      return true;
    },
  } as unknown as EpisodeStoreService;
  const svc = new MentionIngestService(extraction, persist, undefined, episodes);
  return { svc, captured, persisted };
}

describe('mention ingest user-scope pinning (audit 2026-08-21 P0)', () => {
  const saved = process.env.INGEST_EPISODE_ONLY;
  afterEach(() => {
    if (saved === undefined) delete process.env.INGEST_EPISODE_ONLY;
    else process.env.INGEST_EPISODE_ONLY = saved;
  });

  it('M2M assertion rides into episode capture AND fact persistence', async () => {
    delete process.env.INGEST_EPISODE_ONLY;
    const { svc, captured, persisted } = makeService();
    await runWithRequestContext({ correlationId: 't1' }, () =>
      svc.ingestMention('co_x', { ...baseDto, userId: 'user-42' }),
    );
    expect(captured[0].userId).toBe('user-42');
    expect(persisted[0].userId).toBe('user-42');
  });

  it('M2M without an assertion stays tenant-global (unchanged behavior)', async () => {
    delete process.env.INGEST_EPISODE_ONLY;
    const { svc, captured, persisted } = makeService();
    await runWithRequestContext({ correlationId: 't2' }, () =>
      svc.ingestMention('co_x', { ...baseDto }),
    );
    expect(captured[0].userId).toBeUndefined();
    expect(persisted[0].userId).toBeUndefined();
  });

  it('a user-bound token defaults an omitted userId to its own user', async () => {
    delete process.env.INGEST_EPISODE_ONLY;
    const { svc, captured, persisted } = makeService();
    await runWithRequestContext(
      { correlationId: 't3', authUserId: 'did:key:z6MkUser' },
      () => svc.ingestMention('co_x', { ...baseDto }),
    );
    expect(captured[0].userId).toBe('did:key:z6MkUser');
    expect(persisted[0].userId).toBe('did:key:z6MkUser');
  });

  it('a user-bound token cannot write another user\'s scope (403)', async () => {
    delete process.env.INGEST_EPISODE_ONLY;
    const { svc, captured } = makeService();
    await expect(
      runWithRequestContext(
        { correlationId: 't4', authUserId: 'did:key:z6MkUser' },
        () => svc.ingestMention('co_x', { ...baseDto, userId: 'did:key:z6MkOther' }),
      ),
    ).rejects.toThrow(ForbiddenException);
    // Fail BEFORE any write — the episode must not land either.
    expect(captured).toHaveLength(0);
  });

  it('episode-only mode still stamps the captured turn', async () => {
    process.env.INGEST_EPISODE_ONLY = '1';
    const { svc, captured, persisted } = makeService();
    await runWithRequestContext(
      { correlationId: 't5', authUserId: 'did:key:z6MkUser' },
      () => svc.ingestMention('co_x', { ...baseDto }),
    );
    expect(captured[0].userId).toBe('did:key:z6MkUser');
    expect(persisted).toHaveLength(0);
  });
});
