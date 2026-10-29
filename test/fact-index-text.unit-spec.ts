import { factIndexText } from '../src/ingest/fact-index-text';
import { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import type { ExtractorService } from '../src/ai/extractor.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

/** The fact's embedding basis is the bare `predicate: object` (pinned). */
describe('factIndexText', () => {
  it('→ bare "predicate: object" (pinned)', () => {
    expect(factIndexText('rate_limit', '120 requests per minute')).toBe(
      'rate_limit: 120 requests per minute',
    );
    expect(factIndexText('acme_api__rate_limit', '120 requests per minute')).toBe(
      'acme_api__rate_limit: 120 requests per minute',
    );
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
    delete process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING;
  });

  it('embeds bare "predicate: object" (pinned)', async () => {
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['rate_limit: 120 requests per minute']);
  });

  it('composes with the contextual stamp (stamp — base)', async () => {
    process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING = '1';
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['2026-09-01 — rate_limit: 120 requests per minute']);
  });
});
