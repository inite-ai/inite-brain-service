import { redactPii, redactPiiWithReport } from '../src/ingest/ingest-utils';
import { EpisodeStoreService } from '../src/ingest/episode-store.service';
import { MentionIngestService } from '../src/ingest/mention-ingest.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import type { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import type { MentionPersistService } from '../src/ingest/mention-persist.service';

// ── P0: redactor goldens ────────────────────────────────────────────────
// The historical phone regex destroyed temporal text — the exact failure
// class the substrate redesign's P0 exists to stop. Golden pairs pin both
// directions: temporal stays, PII goes.

describe('redactPii goldens (P0)', () => {
  const PRESERVED = [
    '2019-2023',
    'May 7, 1998. 2019 was the year it changed',
    'ratings: 4.5 (2022), 4.8 (2023)',
    'deployed at 2023-05-07 12:34',
    'from 2019 to 2023 she lived in Sweden',
    'scored 8-10 on 2022-01-01',
  ];
  for (const text of PRESERVED) {
    it(`preserves temporal text: "${text}"`, () => {
      expect(redactPii(text)).toBe(text);
    });
  }

  const MASKED: Array<[string, string]> = [
    ['call me at +7 921 123-45-67', 'call me at [PHONE]'],
    // Historical quirks preserved: the match starts at the first digit (the
    // opening paren survives), and a bare 9-digit run hits the phone rule
    // before the NUM rule — masked either way.
    ['office: (555) 123-4567', 'office: ([PHONE]'],
    ['card 1234 5678 9012 3456 expires', 'card [PHONE] expires'],
    ['id 123456789 on file', 'id [PHONE] on file'],
    ['acct 12345678901234567890 on file', 'acct [NUM] on file'],
    ['write to a.b@example.com now', 'write to [EMAIL] now'],
  ];
  for (const [input, expected] of MASKED) {
    it(`masks PII: "${input}"`, () => {
      expect(redactPii(input)).toBe(expected);
    });
  }

  it('reports found classes for piiClass tagging', () => {
    const { classes } = redactPiiWithReport(
      'mail a.b@example.com or +7 921 123-45-67, acct 12345678901234567890',
    );
    expect(classes.sort()).toEqual(['email', 'number', 'phone']);
  });

  it('reports no classes on clean temporal text', () => {
    expect(redactPiiWithReport('2019-2023 were good years').classes).toEqual([]);
  });
});

// ── P1: episode capture ─────────────────────────────────────────────────

function dto(partial: Partial<IngestMentionDto> = {}): IngestMentionDto {
  return {
    text: 'I loved hiking in Sweden in 2019-2023',
    contextRef: {
      vertical: 'locomo',
      conversationId: 'conv-1',
      messageId: 'm-42',
    },
    knownEntities: [
      { vertical: 'locomo', id: 'melanie', role: 'speaker', name: 'Melanie' },
      { vertical: 'locomo', id: 'caroline', role: 'addressee', name: 'Caroline' },
    ],
    emittedAt: '2023-05-07T12:00:00.000Z',
    ...partial,
  } as IngestMentionDto;
}

function makeStore(): {
  svc: EpisodeStoreService;
  queries: Array<{ sql: string; params: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: Record<string, unknown>) => {
          queries.push({ sql, params });
          return [[]];
        },
      }),
  } as unknown as SurrealService;
  return { svc: new EpisodeStoreService(surreal), queries };
}

describe('EpisodeStoreService (P1)', () => {
  const saved = process.env.EPISODE_SUBSTRATE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.EPISODE_SUBSTRATE_ENABLED;
    else process.env.EPISODE_SUBSTRATE_ENABLED = saved;
  });

  it('is a no-op when the flag is off', async () => {
    delete process.env.EPISODE_SUBSTRATE_ENABLED;
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('writes an idempotent INSERT IGNORE row with speaker/addressee/pii', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT IGNORE INTO episode');
    const row = queries[0]!.params.row as Record<string, unknown>;
    expect(row.kind).toBe('turn');
    expect(row.conversationId).toBe('conv-1');
    expect(row.messageId).toBe('m-42');
    expect(row.speaker).toBe('Melanie');
    expect(row.addressee).toBe('Caroline');
    // P0 preserved the year range verbatim.
    expect(row.text).toBe('I loved hiking in Sweden in 2019-2023');
    expect(row.piiClass).toBeUndefined();
    expect(row.occurredAt).toEqual(new Date('2023-05-07T12:00:00.000Z'));
  });

  it('derives a stable content-hash messageId when the caller sent none', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore();
    const noMsg = dto({
      contextRef: { vertical: 'locomo', conversationId: 'conv-1' },
    });
    await svc.captureTurn('co_x', noMsg);
    await svc.captureTurn('co_x', noMsg);
    const ids = queries.map((q) => (q.params.row as Record<string, unknown>).messageId);
    expect(ids[0]).toEqual(ids[1]);
    expect(String(ids[0])).toMatch(/^[0-9a-f]{24}$/);
  });

  it('tags piiClass and stores redacted text', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore();
    await svc.captureTurn('co_x', dto({ text: 'call +7 921 123-45-67' }));
    const row = queries[0]!.params.row as Record<string, unknown>;
    expect(row.text).toBe('call [PHONE]');
    expect(row.piiClass).toEqual(['phone']);
  });

  it('never throws when the DB write fails', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const surreal = {
      withCompany: async () => {
        throw new Error('surreal down');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeStoreService(surreal);
    expect(await svc.captureTurn('co_x', dto())).toBe(false);
  });
});

describe('MentionIngestService captures the episode before extraction', () => {
  const saved = process.env.EPISODE_SUBSTRATE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.EPISODE_SUBSTRATE_ENABLED;
    else process.env.EPISODE_SUBSTRATE_ENABLED = saved;
  });

  it('the turn is captured even when extraction throws', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc: episodes, queries } = makeStore();
    const extraction = {
      prepare: async () => {
        throw new Error('extractor exploded');
      },
    } as unknown as MentionExtractionService;
    const persist = {} as MentionPersistService;
    const ingest = new MentionIngestService(extraction, persist, undefined, episodes);
    await expect(ingest.ingestMention('co_x', dto())).rejects.toThrow('extractor exploded');
    // The episode write happened first — the turn is not lost.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT IGNORE INTO episode');
  });
});
