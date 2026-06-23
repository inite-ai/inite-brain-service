/**
 * EntityResolverService — inline entity resolution logic (unit).
 *
 * Pins the two-zone routing + judge handling that decides whether an
 * extracted entity reuses an existing one (no duplicate) or creates new:
 *   - disabled → always null (create new), no DB / LLM touched
 *   - no candidate above the cosine floor → null
 *   - candidate of a DIFFERENT type → ignored
 *   - candidate ok + judge "same" → reuse existing id
 *   - judge "different" / "unsure" → null
 *   - any judge error → null (never blocks ingest)
 */
import { EntityResolverService } from '../src/ingest/entity-resolver.service';

type Cfg = Record<string, string>;

function makeService(
  cfg: Cfg,
): {
  svc: EntityResolverService;
  db: { query: jest.Mock };
  openai: { chat: { completions: { create: jest.Mock } } };
} {
  const config = {
    get: (k: string, d?: string) => (k in cfg ? cfg[k] : d),
  } as any;
  const embedder = { embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as any;
  const svc = new EntityResolverService(config, embedder);
  const openai = {
    chat: { completions: { create: jest.fn() } },
  };
  // Inject a fake OpenAI client (constructor built one from the api key).
  (svc as any).openai = openai;
  const db = { query: jest.fn() };
  return { svc, db, openai };
}

const ENABLED: Cfg = {
  INGEST_INLINE_RESOLUTION_ENABLED: '1',
  INGEST_INLINE_RESOLUTION_COSINE_FLOOR: '0.85',
  OPENAI_API_KEY: 'sk-test',
};

function verdict(v: string) {
  return { choices: [{ message: { content: JSON.stringify({ verdict: v }) } }] };
}

describe('EntityResolverService.resolveByName', () => {
  it('returns null and touches nothing when disabled', async () => {
    const { svc, db } = makeService({
      ...ENABLED,
      INGEST_INLINE_RESOLUTION_ENABLED: '0',
    });
    const out = await svc.resolveByName(db as any, 'Acme', 'customer', []);
    expect(out).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns null when no candidate clears the cosine floor', async () => {
    const { svc, db, openai } = makeService(ENABLED);
    db.query.mockResolvedValueOnce([
      [{ entityId: 'knowledge_entity:a', etype: 'customer', sim: 0.7 }],
    ]);
    const out = await svc.resolveByName(db as any, 'Acme', 'customer', []);
    expect(out).toBeNull();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('ignores a high-cosine candidate of a different type', async () => {
    const { svc, db, openai } = makeService(ENABLED);
    db.query.mockResolvedValueOnce([
      [{ entityId: 'knowledge_entity:a', etype: 'asset', sim: 0.97 }],
    ]);
    const out = await svc.resolveByName(db as any, 'Acme', 'customer', []);
    expect(out).toBeNull();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('reuses the existing entity when the judge says "same"', async () => {
    const { svc, db, openai } = makeService(ENABLED);
    db.query
      .mockResolvedValueOnce([
        [{ entityId: 'knowledge_entity:x', etype: 'customer', sim: 0.95 }],
      ])
      .mockResolvedValueOnce([[{ predicate: 'dob', object: '1990-01-01' }]]);
    openai.chat.completions.create.mockResolvedValue(verdict('same'));
    const out = await svc.resolveByName(db as any, 'Acme', 'customer', [
      'dob: 1990-01-01',
    ]);
    expect(out).toBe('knowledge_entity:x');
  });

  it('creates new (null) when the judge says "different"', async () => {
    const { svc, db, openai } = makeService(ENABLED);
    db.query
      .mockResolvedValueOnce([
        [{ entityId: 'knowledge_entity:x', etype: 'customer', sim: 0.95 }],
      ])
      .mockResolvedValueOnce([[{ predicate: 'dob', object: '1980-01-01' }]]);
    openai.chat.completions.create.mockResolvedValue(verdict('different'));
    const out = await svc.resolveByName(db as any, 'John Smith', 'customer', [
      'dob: 1990-01-01',
    ]);
    expect(out).toBeNull();
  });

  it('falls back to null when the judge throws', async () => {
    const { svc, db, openai } = makeService(ENABLED);
    db.query
      .mockResolvedValueOnce([
        [{ entityId: 'knowledge_entity:x', etype: 'customer', sim: 0.95 }],
      ])
      .mockResolvedValueOnce([[{ predicate: 'dob', object: '1990' }]]);
    openai.chat.completions.create.mockRejectedValue(new Error('LLM down'));
    const out = await svc.resolveByName(db as any, 'Acme', 'customer', []);
    expect(out).toBeNull();
  });
});
