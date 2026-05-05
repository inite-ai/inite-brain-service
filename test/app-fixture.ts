import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { EmbedderService } from '../src/ai/embedder.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { StubEmbedder, StubExtractor } from './test-doubles';

export interface AppFixture {
  app: INestApplication;
  http: ReturnType<typeof request>;
  apiKey: string;
  companyId: string;
  extractor: StubExtractor;
  close: () => Promise<void>;
}

export async function createApp(opts: {
  companyId?: string;
  scopes?: string[];
} = {}): Promise<AppFixture> {
  const companyId = opts.companyId ?? `co_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = `key_${randomUUID()}`;
  const keyHash = 'sha256:' + createHash('sha256').update(apiKey).digest('hex');
  process.env.BRAIN_API_KEYS = JSON.stringify([
    {
      keyHash,
      companyId,
      scopes: opts.scopes ?? ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
    },
  ]);
  // Bypass real OpenAI calls.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';

  const stubExtractor = new StubExtractor();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EmbedderService).useValue(new StubEmbedder())
    .overrideProvider(ExtractorService).useValue(stubExtractor)
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  const http = request(app.getHttpServer());
  return {
    app,
    http,
    apiKey,
    companyId,
    extractor: stubExtractor,
    close: () => app.close(),
  };
}
