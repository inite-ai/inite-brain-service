/**
 * The commit reads the ids of the turns a document's arrival captured
 * (CommitWriterService.commitTurns) — one read instead of a
 * capture per turn; a document whose turns are missing is captured.
 */
import { CommitWriterService } from '../src/documents/commit-writer.service';

function make(episodeRows: Array<{ id: string; messageId: string }>) {
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM source_chunk')) return [[{ seq: 0, text: 'Hello there.' }], [{}]];
      if (sql.includes('FROM episode')) return [episodeRows];
      return [[]];
    }),
  };
  const episodes = {
    isEnabled: () => true,
    captureTurn: jest.fn(async () => 'episode:captured'),
  };
  const svc = new CommitWriterService({} as never, {} as never, {} as never, episodes as never);
  const doc = {
    id: 'source_document:d1',
    hasContent: true,
    vertical: 'notes',
    occurredAt: new Date('2026-09-20T10:00:00Z'),
    meta: undefined,
  } as never;
  return { svc, db, episodes, doc };
}

describe('CommitWriterService.commitTurns', () => {
  it('reads the captured ids instead of capturing again', async () => {
    const { svc, db, episodes, doc } = make([{ id: 'episode:t0', messageId: 'turn:0' }]);
    const out = await svc.commitTurns(db as never, 'co', doc);
    expect(out?.ids).toEqual(['episode:t0']);
    expect(episodes.captureTurn).not.toHaveBeenCalled();
  });

  it('captures when a turn is missing, and always on arrival', async () => {
    const missing = make([]);
    const a = await missing.svc.commitTurns(missing.db as never, 'co', missing.doc);
    expect(a?.ids).toEqual(['episode:captured']);
    const arrival = make([{ id: 'episode:t0', messageId: 'turn:0' }]);
    await arrival.svc.captureTurns(arrival.db as never, 'co', arrival.doc);
    expect(arrival.episodes.captureTurn).toHaveBeenCalledTimes(1);
  });
});
