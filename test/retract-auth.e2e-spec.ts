/**
 * Phase audit closure — verify that the retract endpoint requires
 * brain:admin (not just brain:write) when the target fact's predicate
 * is in RETRACT_ADMIN_PREDICATES or its source.kind === 'legal'.
 *
 * Pre-fix POST /v1/facts/:id/retract accepted any brain:write key.
 * A leaked write-only credential could thus issue a GDPR-grade
 * cascade-delete on billing_event / human_declared / legal rows.
 */
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EmbedderService } from '../src/ai/embedder.service';
import { ExtractorService } from '../src/ai/extractor.service';
import { StubEmbedder, StubExtractor } from './test-doubles';
import { randomUUID, createHash } from 'node:crypto';
import supertest from 'supertest';

describe('POST /v1/facts/:id/retract — predicate-class auth', () => {
  let app: any;
  let http: ReturnType<typeof supertest>;
  let companyId: string;
  let writeOnlyKey: string;
  let adminKey: string;

  beforeAll(async () => {
    companyId = `co_retract_auth_${Date.now()}`;
    writeOnlyKey = `key_w_${randomUUID()}`;
    adminKey = `key_a_${randomUUID()}`;
    const writeHash =
      'sha256:' + createHash('sha256').update(writeOnlyKey).digest('hex');
    const adminHash =
      'sha256:' + createHash('sha256').update(adminKey).digest('hex');
    process.env.BRAIN_API_KEYS = JSON.stringify([
      { keyHash: writeHash, companyId, scopes: ['brain:read', 'brain:write'] },
      {
        keyHash: adminHash,
        companyId,
        scopes: ['brain:read', 'brain:write', 'brain:admin'],
      },
    ]);
    process.env.OPENAI_API_KEY = 'sk-test-stub';
    process.env.THROTTLE_LIMIT = '1000000';
    process.env.THROTTLE_EXPENSIVE_LIMIT = '1000000';
    delete process.env.SURREALDB_SCOPED_USER;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmbedderService)
      .useValue(new StubEmbedder())
      .overrideProvider(ExtractorService)
      .useValue(new StubExtractor())
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function ingest(
    key: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const r = await http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${key}` })
      .send({
        entityRef: { vertical: 'rent', id: 'subj_retract_auth' },
        validFrom: '2026-01-01',
        confidence: 0.9,
        ...payload,
      });
    expect([200, 201]).toContain(r.status);
    return r.body.factId as string;
  }

  it('brain:write can retract a normal-predicate fact (allowed)', async () => {
    const factId = await ingest(writeOnlyKey, {
      predicate: 'tier',
      object: 'silver',
      source: { vertical: 'rent', recorder: 'bot' },
    });
    const r = await http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set({ Authorization: `Bearer ${writeOnlyKey}` })
      .send({ reason: 'wrong', retractedBy: { source: 'human' } });
    expect([200, 201]).toContain(r.status);
  });

  it('brain:write is REJECTED on billing_event predicate (403)', async () => {
    const factId = await ingest(writeOnlyKey, {
      predicate: 'billing_event',
      object: 'invoice-1234',
      source: { vertical: 'rent', recorder: 'billing' },
    });
    const r = await http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set({ Authorization: `Bearer ${writeOnlyKey}` })
      .send({ reason: 'wrong', retractedBy: { source: 'human' } });
    expect(r.status).toBe(403);
  });

  it('brain:admin can retract the same billing_event fact', async () => {
    const factId = await ingest(adminKey, {
      predicate: 'billing_event',
      object: 'invoice-5678',
      source: { vertical: 'rent', recorder: 'billing' },
    });
    const r = await http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set({ Authorization: `Bearer ${adminKey}` })
      .send({ reason: 'correction', retractedBy: { source: 'human' } });
    expect([200, 201]).toContain(r.status);
  });

  it('brain:write is REJECTED when source.kind = "legal"', async () => {
    const factId = await ingest(writeOnlyKey, {
      predicate: 'tier',
      object: 'platinum',
      source: { vertical: 'rent', recorder: 'court', kind: 'legal' },
    });
    const r = await http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set({ Authorization: `Bearer ${writeOnlyKey}` })
      .send({ reason: 'wrong', retractedBy: { source: 'human' } });
    expect(r.status).toBe(403);
  });
});
