/**
 * Phase 4.A closure e2e — verify that mention-ingested facts get
 * lang/script tagging, matching what direct-ingested facts have always
 * gotten.
 *
 * Pre-fix the chat-router / conversational corpora bypassed the pass
 * because recordExtractedFact() in IngestService skipped them. The
 * audit flagged this as a Phase-coverage gap.
 */
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EmbedderService } from '../src/ai/embedder.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { SurrealService } from '../src/db/surreal.service';
import { StubEmbedder, StubExtractor } from './test-doubles';
import { randomUUID, createHash } from 'node:crypto';
import supertest from 'supertest';

describe('mention-path locale coverage', () => {
  let app: any;
  let http: ReturnType<typeof supertest>;
  let companyId: string;
  let apiKey: string;
  let surreal: SurrealService;

  beforeAll(async () => {
    companyId = `co_mloc_${Date.now()}`;
    apiKey = `key_${randomUUID()}`;
    const keyHash =
      'sha256:' + createHash('sha256').update(apiKey).digest('hex');
    process.env.BRAIN_API_KEYS = JSON.stringify([
      {
        keyHash,
        companyId,
        scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      },
    ]);
    process.env.OPENAI_API_KEY = 'sk-test-stub';
    process.env.THROTTLE_LIMIT = '1000000';
    process.env.THROTTLE_EXPENSIVE_LIMIT = '1000000';
    delete process.env.SURREALDB_SCOPED_USER;

    // Configure the stub extractor to emit a Russian fact so the
    // language detector lands on 'ru' (the detector is stopword-scored,
    // a few cyrillic tokens suffice).
    const stubExtractor = new StubExtractor();
    stubExtractor.setScript({
      entities: [{ name: 'Мария', type: 'customer' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'name',
          object: 'Мария Иванова — главный инженер компании',
          confidence: 0.9,
        },
      ],
      edges: [],
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmbedderService)
      .useValue(new StubEmbedder())
      .overrideProvider(ExtractorService)
      .useValue(stubExtractor)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    http = supertest(app.getHttpServer());
    surreal = app.get(SurrealService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('mention-ingested fact gets lang+script tagged', async () => {
    const r = await http
      .post('/v1/ingest/mention')
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({
        text: 'Мария Иванова — главный инженер компании',
        contextRef: { vertical: 'rent', conversationId: 'conv_1' },
        emittedAt: new Date().toISOString(),
      });
    expect([200, 201]).toContain(r.status);
    expect(r.body.extractedFactIds?.length).toBeGreaterThan(0);

    const factId = r.body.extractedFactIds[0];
    const row = await surreal.withCompany(companyId, async (db) => {
      const tail = String(factId).includes(':')
        ? String(factId).split(':')[1]
        : String(factId);
      const [rows] = await db.query<any[][]>(
        `SELECT lang, script FROM type::record('knowledge_fact', $t)`,
        { t: tail },
      );
      return (rows as any[])?.[0] ?? null;
    });
    expect(row).not.toBeNull();
    // Language detector: Russian text + Cyrillic script.
    expect(row.lang).toBe('ru');
    expect(row.script).toBe('Cyrl');
  });
});
