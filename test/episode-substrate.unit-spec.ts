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

function makeStore(opts: { insertRows?: unknown[]; selectIds?: unknown[] } = {}): {
  svc: EpisodeStoreService;
  queries: Array<{ sql: string; params: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const surreal = {
    withCompany: async (_co: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: Record<string, unknown>) => {
          queries.push({ sql, params });
          if (sql.startsWith('INSERT IGNORE')) {
            // Default: a fresh insert returns the created row (id contract).
            return [opts.insertRows ?? [{ id: 'episode:new1' }]];
          }
          // The duplicate-recovery SELECT VALUE id fallback.
          return [opts.selectIds ?? []];
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

  it('is a no-op when the flag is off (null, no query)', async () => {
    delete process.env.EPISODE_SUBSTRATE_ENABLED;
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('writes an idempotent INSERT IGNORE row with speaker/addressee/pii and returns the id', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore();
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:new1');
    expect(queries).toHaveLength(1);
    // The INSERT statement is byte-identical to the pre-Drift-1 form.
    expect(queries[0]!.sql).toBe('INSERT IGNORE INTO episode $row');
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

  it('never throws when the DB write fails (null)', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const surreal = {
      withCompany: async () => {
        throw new Error('surreal down');
      },
    } as unknown as SurrealService;
    const svc = new EpisodeStoreService(surreal);
    expect(await svc.captureTurn('co_x', dto())).toBeNull();
  });

  it('duplicate (INSERT IGNORE returns no row) → id recovered via the unique-key SELECT', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore({ insertRows: [], selectIds: ['episode:dup1'] });
    expect(await svc.captureTurn('co_x', dto())).toBe('episode:dup1');
    expect(queries).toHaveLength(2);
    expect(queries[1]!.sql).toContain(
      'SELECT VALUE id FROM episode WHERE conversationId = $conv AND messageId = $mid',
    );
    expect(queries[1]!.params).toEqual({ conv: 'conv-1', mid: 'm-42' });
  });

  it('duplicate WITHOUT a conversationId → the WHERE says IS NONE (optional contextRef field)', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc, queries } = makeStore({ insertRows: [], selectIds: ['episode:dup2'] });
    const noConv = dto({ contextRef: { vertical: 'locomo', messageId: 'm-9' } });
    expect(await svc.captureTurn('co_x', noConv)).toBe('episode:dup2');
    expect(queries[1]!.sql).toContain(
      'SELECT VALUE id FROM episode WHERE conversationId IS NONE AND messageId = $mid',
    );
    expect(queries[1]!.params).toEqual({ mid: 'm-9' });
  });

  it('duplicate whose fallback SELECT also finds nothing → null (never throws)', async () => {
    process.env.EPISODE_SUBSTRATE_ENABLED = '1';
    const { svc } = makeStore({ insertRows: [], selectIds: [] });
    expect(await svc.captureTurn('co_x', dto())).toBeNull();
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

// ── Drift-1: fail-closed capture (EVIDENCE_FAIL_CLOSED_CAPTURE) ─────────

function makeMentionStack(episodeId: string | null) {
  const persisted: Array<Record<string, unknown>> = [];
  const mentionMetrics: string[] = [];
  const prepSource = { vertical: 'locomo', recorder: 'stub-model' };
  const extraction = {
    prepare: jest.fn(async () => ({
      skip: null,
      extraction: { entities: [], facts: [], edges: [] },
      source: prepSource,
      factEmbeddings: [],
    })),
  } as unknown as MentionExtractionService;
  const persist = {
    persistAll: async (p: Record<string, unknown>) => {
      persisted.push(p);
      return { extractedEntityIds: [], extractedFactIds: [] };
    },
  } as unknown as MentionPersistService;
  const metrics = {
    countIngestWrite: () => {},
    countIngestMention: (o: string) => mentionMetrics.push(o),
  } as never;
  const episodes = {
    captureTurn: async () => episodeId,
  } as unknown as EpisodeStoreService;
  const svc = new MentionIngestService(extraction, persist, metrics, episodes);
  return { svc, persisted, mentionMetrics, prepSource, extraction };
}

describe('MentionIngestService — fail-closed capture (EVIDENCE_FAIL_CLOSED_CAPTURE)', () => {
  const saved = process.env.EVIDENCE_FAIL_CLOSED_CAPTURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_FAIL_CLOSED_CAPTURE;
    else process.env.EVIDENCE_FAIL_CLOSED_CAPTURE = saved;
  });

  it('flag ON + capture null → 503, metric failed, extraction never runs', async () => {
    process.env.EVIDENCE_FAIL_CLOSED_CAPTURE = '1';
    const { svc, mentionMetrics, extraction, persisted } = makeMentionStack(null);
    await expect(svc.ingestMention('co_x', dto())).rejects.toMatchObject({
      status: 503,
    });
    expect(mentionMetrics).toEqual(['failed']);
    expect((extraction as unknown as { prepare: jest.Mock }).prepare).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  it('flag ON + captured id → the id is stamped into the persisted source.episodeIds', async () => {
    process.env.EVIDENCE_FAIL_CLOSED_CAPTURE = '1';
    const { svc, persisted, prepSource } = makeMentionStack('episode:cap1');
    const out = await svc.ingestMention('co_x', dto());
    expect(out.skipped).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.source).toEqual({
      vertical: 'locomo',
      recorder: 'stub-model',
      episodeIds: ['episode:cap1'],
    });
    // The extraction's own source object is never mutated.
    expect(prepSource).toEqual({ vertical: 'locomo', recorder: 'stub-model' });
  });

  it('flag OFF (default) → the capture result is discarded and persistAll receives the IDENTICAL source', async () => {
    delete process.env.EVIDENCE_FAIL_CLOSED_CAPTURE;
    const { svc, persisted, prepSource } = makeMentionStack('episode:cap1');
    const out = await svc.ingestMention('co_x', dto());
    expect(out.skipped).toBe(false);
    // Byte-identity: the very same object reference, no episodeIds key.
    expect(persisted[0]!.source).toBe(prepSource);
    expect(persisted[0]!.source).toEqual({ vertical: 'locomo', recorder: 'stub-model' });
  });

  it('flag OFF + capture null → mention still ingests (advisory capture, unchanged behavior)', async () => {
    delete process.env.EVIDENCE_FAIL_CLOSED_CAPTURE;
    const { svc, persisted, mentionMetrics } = makeMentionStack(null);
    const out = await svc.ingestMention('co_x', dto());
    expect(out.skipped).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(mentionMetrics).toEqual(['extracted']);
  });
});
