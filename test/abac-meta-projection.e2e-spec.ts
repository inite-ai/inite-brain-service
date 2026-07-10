/**
 * Metadata projection end-to-end (the Zep episode-metadata equivalent):
 *   - document path: IngestDocumentDto.meta → source_document.meta →
 *     commit-writer stamps sanitized `source.meta` on derived facts →
 *     a `source.meta.data_class` policy hides them
 *   - direct path: IngestFactDto.metadata (historically dropped) →
 *     `source.meta` → same policy applies
 *   - SOURCE_META_STRICT=1 turns sanitizer drops into a 400
 */
import { AppFixture, createApp } from './app-fixture';

jest.setTimeout(180_000);

const NO_PII_CLASS_DOC = {
  name: 'no-pii-class',
  description: 'hide facts whose source.meta.data_class is pii',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'enforce',
  rules: [
    {
      id: 'meta-pii',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.meta.data_class', op: 'eq', value: 'pii' }],
    },
  ],
};

describe('ABAC source.meta projection', () => {
  let f: AppFixture;
  let restrictedKey: string;

  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], policies: ['no-pii-class'] },
      ],
    });
    [restrictedKey] = f.extraApiKeys;
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set(auth())
      .send(NO_PII_CLASS_DOC);
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.SOURCE_META_STRICT;
    await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
  });

  it('document meta lands on derived facts and the policy filters them', async () => {
    f.extractor.setScript({
      entities: [{ name: 'Jane Doe', type: 'staff' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'note',
          object: 'salary negotiation details',
          confidence: 0.9,
        },
      ],
      edges: [],
    });
    const doc = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        occurredAt: '2026-07-01T10:00:00.000Z',
        contextRef: { vertical: 'hr_docs', recorder: 'hr-sync' },
        text: 'HR interview notes about Jane.',
        meta: { data_class: 'pii', department: 'people' },
      });
    expect(doc.status).toBe(201);
    expect(doc.body.committed.factIds).toHaveLength(1);
    const factId = doc.body.committed.factIds[0] as string;

    // Explain shows the projected meta on the fact's policy view.
    const explain = await f.http
      .post('/v1/admin/policy-sets/explain')
      .set(auth())
      .send({ policyNames: ['no-pii-class'], factId });
    expect(explain.status).toBe(201);
    expect(explain.body.row.decision).toBe('deny');
    expect(explain.body.row.view.source.meta).toEqual({
      data_class: 'pii',
      department: 'people',
    });

    // And the row filter hides it from a restricted key's search.
    const full = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'salary negotiation' });
    expect(
      full.body.results.flatMap((h: any) => h.facts).map((x: any) => x.object),
    ).toContain('salary negotiation details');

    const restricted = await f.http
      .post('/v1/search')
      .set(auth(restrictedKey))
      .send({ query: 'salary negotiation' });
    expect(
      restricted.body.results.flatMap((h: any) => h.facts).map((x: any) => x.object),
    ).not.toContain('salary negotiation details');
  });

  it('direct-path metadata is honored (no longer silently dropped)', async () => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'subj_meta_direct' },
        predicate: 'preference',
        object: 'direct fact with meta',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        metadata: { data_class: 'pii' },
      });
    expect([200, 201]).toContain(r.status);

    const explain = await f.http
      .post('/v1/admin/policy-sets/explain')
      .set(auth())
      .send({ policyNames: ['no-pii-class'], factId: r.body.factId });
    expect(explain.body.row.decision).toBe('deny');
    expect(explain.body.row.view.source.meta).toEqual({ data_class: 'pii' });
  });

  it('sanitizer drops invalid entries silently by default, 400s under SOURCE_META_STRICT', async () => {
    const lax = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'subj_meta_lax' },
        predicate: 'preference',
        object: 'lax meta fact',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        metadata: { 'Bad Key!': 'x', ok_key: 'kept' },
      });
    expect([200, 201]).toContain(lax.status);

    process.env.SOURCE_META_STRICT = '1';
    try {
      const strict = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'subj_meta_strict' },
          predicate: 'preference',
          object: 'strict meta fact',
          validFrom: '2026-01-01',
          confidence: 0.9,
          source: { vertical: 'rent', recorder: 'bot' },
          metadata: { 'Bad Key!': 'x' },
        });
      expect(strict.status).toBe(400);
      expect(strict.body.error).toBe('invalid_metadata');

      const strictDoc = await f.http
        .post('/v1/ingest/document')
        .set(auth())
        .send({
          kind: 'markdown',
          occurredAt: '2026-07-01T10:00:00.000Z',
          contextRef: { vertical: 'hr_docs' },
          text: 'strict-mode document meta test',
          meta: { nested: { not: 'allowed' } },
        });
      expect(strictDoc.status).toBe(400);
    } finally {
      delete process.env.SOURCE_META_STRICT;
    }
  });
});
