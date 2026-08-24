import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { EmbedderService } from '../src/ai/embedder.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { correlationIdMiddleware } from '../src/common/correlation-id.middleware';
import { StubEmbedder, StubExtractor } from './test-doubles';

export interface AppFixture {
  app: INestApplication;
  http: ReturnType<typeof request>;
  apiKey: string;
  /** Plaintext keys for opts.extraKeys, in order. */
  extraApiKeys: string[];
  companyId: string;
  extractor: StubExtractor;
  close: () => Promise<void>;
}

export async function createApp(
  opts: {
    companyId?: string;
    scopes?: string[];
    /**
     * When true, configure the scoped pool (SURREALDB_SCOPED_USER/PASS).
     * Migration 0005 defines `brain_caller` user with a known default
     * password — fixture wires those env vars so the pool boots in
     * scoped mode. Caller-facing endpoints then route through scoped
     * connections and DB-level PERMISSIONS apply.
     */
    enableScopedPool?: boolean;
    /**
     * Additional static keys for the SAME tenant — the ABAC suites need a
     * privileged admin key plus a policy-restricted caller key in one
     * boot (BRAIN_API_KEYS is parsed once at module init). `policies`
     * maps to the entry's ABAC attachment field.
     */
    extraKeys?: Array<{
      scopes: string[];
      policies?: string[];
      packIds?: string[];
      /**
       * End-user identity for a USER-BOUND token (ApiKeyRecord.userId).
       * The guard stamps it into ALS as authUserId, so pinUserScope()
       * fences this key to one user's slice — the seam the per-user
       * scope + retract-ownership suites need to exercise.
       */
      userId?: string;
    }>;
  } = {},
): Promise<AppFixture> {
  const companyId = opts.companyId ?? `co_test_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const apiKey = `key_${randomUUID()}`;
  const keyHash = 'sha256:' + createHash('sha256').update(apiKey).digest('hex');
  const extraApiKeys = (opts.extraKeys ?? []).map(() => `key_${randomUUID()}`);
  process.env.BRAIN_API_KEYS = JSON.stringify([
    {
      keyHash,
      companyId,
      scopes: opts.scopes ?? ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
    },
    ...(opts.extraKeys ?? []).map((k, i) => ({
      keyHash: 'sha256:' + createHash('sha256').update(extraApiKeys[i]!).digest('hex'),
      companyId,
      scopes: k.scopes,
      ...(k.policies ? { policies: k.policies } : {}),
      ...(k.packIds ? { packIds: k.packIds } : {}),
      ...(k.userId ? { userId: k.userId } : {}),
    })),
  ]);
  // Bypass real OpenAI calls.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
  // Disable throttling in e2e — the test suites fire FANOUT bursts of
  // ingest/search per spec to exercise concurrency invariants, and the
  // prod-default 120/60s + expensive 10/60s caps trip them at 429.
  // The throttler itself is covered by `test/throttler.unit-spec.ts`.
  process.env.THROTTLE_LIMIT = '1000000';
  process.env.THROTTLE_EXPENSIVE_LIMIT = '1000000';
  // The env limits above only reach the named-bucket defaults; per-route
  // @Throttle decorators hardcode their own (e.g. search/synthesize at
  // 10/min). Hard-disable throttling in e2e so a suite firing >10
  // expensive calls doesn't 429. See TenantThrottlerGuard.shouldSkip.
  process.env.THROTTLE_DISABLED = '1';
  if (opts.enableScopedPool) {
    process.env.SURREALDB_SCOPED_USER = 'brain_caller';
    process.env.SURREALDB_SCOPED_PASS = 'brain-caller-password-must-be-overridden-via-env';
  } else {
    delete process.env.SURREALDB_SCOPED_USER;
    delete process.env.SURREALDB_SCOPED_PASS;
  }

  const stubExtractor = new StubExtractor();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EmbedderService)
    .useValue(new StubEmbedder())
    .overrideProvider(ExtractorService)
    .useValue(stubExtractor)
    .compile();

  const app = moduleRef.createNestApplication();
  // Mirror main.ts: the correlation middleware also carries the
  // AsyncLocalStorage request context that ABAC row filtering reads
  // (getPolicyContext) — without it the row gate is silently inactive
  // and the abac e2e suites would pass vacuously.
  app.use(correlationIdMiddleware());
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
    extraApiKeys,
    companyId,
    extractor: stubExtractor,
    close: () => app.close(),
  };
}
