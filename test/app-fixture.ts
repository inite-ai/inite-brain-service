import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { EmbedderService } from '../src/ai/embedder.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { LocalCrossEncoderProvider } from '../src/ai/cross-encoder/local-cross-encoder.provider';
import { correlationIdMiddleware } from '../src/common/correlation-id.middleware';
import { StubEmbedder, StubExtractor, StubLocalCrossEncoder } from './test-doubles';

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
  // No ONNX model loads in the e2e process — the same policy the
  // EmbedderService / ExtractorService stubs below already apply, now
  // extended to the two models AppModule boots on its own. This is the
  // NLI one: IntentClassifierService.onModuleInit fire-and-forgets a
  // warmup that spawns a worker_thread and pulls ~135MB of weights
  // (Xenova/distilbert-base-multilingual-cased-finetuned-mnli) on EVERY
  // createApp(). No e2e spec asserts on NLI intent (the wire contract is
  // covered by test/contracts-admin-health-components.unit-spec.ts, the
  // classifier by test/chat-router-intent.unit-spec.ts), and the model
  // never finished warming inside a spec anyway, so classify() already
  // served the punctuation fallback — this only makes that deterministic
  // and stops the load/teardown churn. See test/jest-e2e.json.
  process.env.CHAT_ROUTE_NLI_ENABLED = 'false';
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
    // The other model AppModule boots (see CHAT_ROUTE_NLI_ENABLED above):
    // the ~279MB reranker. CrossEncoderService takes this provider
    // @Optional(), so the stub keeps isLocalOnly()/isEnabled() true and
    // the rerank stage is still entered — it just resolves to the
    // identity permutation instead of spawning an ONNX worker thread.
    .overrideProvider(LocalCrossEncoderProvider)
    .useValue(new StubLocalCrossEncoder())
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
