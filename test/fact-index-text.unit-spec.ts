import { factIndexText, humanizePredicate } from '../src/ingest/fact-index-text';
import { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import type { ExtractorService } from '../src/ai/extractor.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

/**
 * INGEST_PREDICATE_INDEX_TEXT — humanized predicate words in the fact's
 * embedding basis (code-memory battery k07: "rate limit" lives ONLY in the
 * predicate name `rate_limit`, so the stored vector never matches the
 * natural-language query). Off → the historical `predicate: object`,
 * byte-identical (pinned). On → ` — <humanized>` appended, pack `__`
 * prefix stripped, token-dedup guarded.
 */
describe('factIndexText (INGEST_PREDICATE_INDEX_TEXT)', () => {
  afterEach(() => {
    delete process.env.INGEST_PREDICATE_INDEX_TEXT;
  });

  it('off (unset) → bare "predicate: object", byte-identical (pinned)', () => {
    expect(factIndexText('rate_limit', '120 requests per minute')).toBe(
      'rate_limit: 120 requests per minute',
    );
  });

  it('off (=0) → bare "predicate: object", byte-identical (pinned)', () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '0';
    expect(factIndexText('rate_limit', '120 requests per minute')).toBe(
      'rate_limit: 120 requests per minute',
    );
    expect(factIndexText('acme_api__rate_limit', '120 requests per minute')).toBe(
      'acme_api__rate_limit: 120 requests per minute',
    );
  });

  it('on → appends the humanized predicate words', () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '1';
    const text = factIndexText('rate_limit', '120 requests per minute');
    expect(text).toBe('rate_limit: 120 requests per minute — rate limit');
    expect(text).toContain('rate limit');
    expect(factIndexText('http_status', '429')).toBe('http_status: 429 — http status');
  });

  it('on → strips the pack `<packId>__` prefix from the humanized form', () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '1';
    expect(factIndexText('acme_api__rate_limit', '120 requests per minute')).toBe(
      'acme_api__rate_limit: 120 requests per minute — rate limit',
    );
  });

  it('on → dedup: no append when the humanized words add no new tokens', () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '1';
    // identifier-class: the object already IS the identifier — no silly
    // "identifier: LSYNC_REPLAY_ENABLED — identifier" tail.
    expect(factIndexText('identifier', 'LSYNC_REPLAY_ENABLED')).toBe(
      'identifier: LSYNC_REPLAY_ENABLED',
    );
    // Single natural-word predicates are already their own humanized form.
    expect(factIndexText('preference', 'hiking')).toBe('preference: hiking');
    // Object already phrases the predicate words — nothing to add.
    expect(factIndexText('rate_limit', 'the rate limit is 120')).toBe(
      'rate_limit: the rate limit is 120',
    );
  });

  it('humanizePredicate: underscores → spaces, pack prefix stripped', () => {
    expect(humanizePredicate('rate_limit')).toBe('rate limit');
    expect(humanizePredicate('acme_pack__rate_limit')).toBe('rate limit');
    expect(humanizePredicate('identifier')).toBe('identifier');
    expect(humanizePredicate('duration_limit')).toBe('duration limit');
  });
});

/** Wiring: the mention path (the code-memory battery's ingest path) embeds
 *  the builder's output, and the contextual stamp composes around it. */
describe('MentionExtractionService predicate index text', () => {
  const extraction = {
    entities: [{ name: 'acme-api', type: 'other' }],
    facts: [{ predicate: 'rate_limit', object: '120 requests per minute', entityIndex: 0 }],
    edges: [],
  };

  function make(): { svc: MentionExtractionService; embedded: string[][] } {
    const embedded: string[][] = [];
    const extractor = {
      extract: async () => extraction,
      modelId: () => 'test-model',
    } as unknown as ExtractorService;
    const factEmbedding = {
      embedMany: async (texts: string[]) => {
        embedded.push(texts);
        return texts.map(() => [0]);
      },
    } as unknown as FactEmbeddingService;
    return {
      svc: new MentionExtractionService(extractor, factEmbedding),
      embedded,
    };
  }

  const dto = {
    text: 'acme-api throttles at 120 requests per minute',
    emittedAt: '2026-09-01T10:00:00.000Z',
    contextRef: { vertical: 'code', recorder: 'r' },
  } as unknown as IngestMentionDto;

  afterEach(() => {
    delete process.env.INGEST_PREDICATE_INDEX_TEXT;
    delete process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING;
  });

  it('off → embeds bare "predicate: object" (byte-identical, pinned)', async () => {
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['rate_limit: 120 requests per minute']);
  });

  it('on → embeds the humanized-predicate index text', async () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '1';
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['rate_limit: 120 requests per minute — rate limit']);
  });

  it('stacks with the contextual stamp (stamp — base — humanized)', async () => {
    process.env.INGEST_PREDICATE_INDEX_TEXT = '1';
    process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING = '1';
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['2026-09-01 — rate_limit: 120 requests per minute — rate limit']);
  });
});
