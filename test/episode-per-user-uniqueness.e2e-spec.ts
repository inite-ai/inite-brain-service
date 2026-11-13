/**
 * A turn's identity includes whose turn it is (0193). Conversation and
 * message ids are the client's, and two end users of one client app share
 * them freely ("main", "1"): each user's turn must be stored as its own
 * episode, and a replay of one user's turn must recover THAT user's row —
 * never the other user's.
 */
import { AppFixture, createApp } from './app-fixture';
import { EpisodeStoreService } from '../src/ingest/episode-store.service';
import { SurrealService } from '../src/db/surreal.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

describe('episode uniqueness is per user (real SurrealDB)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_episode_user_uq_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const turn = (userId: string | undefined, text: string): IngestMentionDto =>
    ({
      text,
      emittedAt: '2026-11-13T10:00:00.000Z',
      ...(userId ? { userId } : {}),
      contextRef: { vertical: 'proj', conversationId: 'main', messageId: '1' },
    }) as unknown as IngestMentionDto;

  it('two users with the same client ids get two episodes; a replay recovers its own', async () => {
    const store = f.app.get(EpisodeStoreService);
    const a = await store.captureTurn(f.companyId, turn('user_a', 'I moved to Lisbon.'));
    const b = await store.captureTurn(f.companyId, turn('user_b', 'I moved to Porto.'));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);

    // A replay of each user's turn is idempotent and returns that user's row.
    expect(await store.captureTurn(f.companyId, turn('user_a', 'I moved to Lisbon.'))).toBe(a);
    expect(await store.captureTurn(f.companyId, turn('user_b', 'I moved to Porto.'))).toBe(b);

    const rows = await f.app.get(SurrealService).withCompany(f.companyId, async (db) => {
      const [r] = await db.query<[Array<{ userId?: string; text: string }>]>(
        `SELECT userId, text FROM episode WHERE conversationId = 'main' ORDER BY userId`,
      );
      return r ?? [];
    });
    expect(rows.map((r) => r.userId)).toEqual(['user_a', 'user_b']);
  });

  it('tenant-global turns (no user) still deduplicate among themselves', async () => {
    const store = f.app.get(EpisodeStoreService);
    const g1 = await store.captureTurn(f.companyId, {
      ...turn(undefined, 'Office closes at six.'),
      contextRef: { vertical: 'proj', conversationId: 'global', messageId: '7' },
    } as IngestMentionDto);
    const g2 = await store.captureTurn(f.companyId, {
      ...turn(undefined, 'Office closes at six.'),
      contextRef: { vertical: 'proj', conversationId: 'global', messageId: '7' },
    } as IngestMentionDto);
    expect(g1).not.toBeNull();
    expect(g2).toBe(g1);
  });
});
