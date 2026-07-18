import { MentionExtractionService } from '../src/ingest/mention-extraction.service';
import type { ExtractorService } from '../src/ai/extractor.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';

/**
 * INGEST_CONTEXTUAL_FACT_EMBEDDING — the fact-level Contextual Retrieval
 * stamp. Off → bare "predicate: object" (byte-identical); on → speaker + date
 * prepended so the stored vector matches context-referencing queries.
 */
describe('MentionExtractionService contextual fact embedding', () => {
  const extraction = {
    entities: [{ name: 'Caroline', type: 'other' }],
    facts: [{ predicate: 'preference', object: 'hiking', entityIndex: 0 }],
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
    text: 'I love hiking',
    emittedAt: '2023-05-07T10:00:00.000Z',
    contextRef: { vertical: 'locomo', recorder: 'r' },
    knownEntities: [{ vertical: 'locomo', id: 'c', role: 'speaker', name: 'Caroline' }],
  } as unknown as IngestMentionDto;

  afterEach(() => {
    delete process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING;
  });

  it('off → embeds bare "predicate: object"', async () => {
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['preference: hiking']);
  });

  it('on → prepends speaker + session date to the embedded text', async () => {
    process.env.INGEST_CONTEXTUAL_FACT_EMBEDDING = '1';
    const { svc, embedded } = make();
    await svc.prepare('co_x', dto);
    expect(embedded[0]).toEqual(['Caroline, 2023-05-07 — preference: hiking']);
  });
});
