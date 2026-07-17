/**
 * A0 — mention-path user scoping (migration 0055). Persona / personal
 * memory ingested via the mention path must stamp userId onto the
 * resolved entity and scope the canonical-name match to the user, so the
 * fail-closed read fence only surfaces it to that user. Omitted userId
 * stays tenant-global (byte-identical).
 */
import { dbCreate } from '../src/db/surreal.service';
import { EntityUpsertService } from '../src/ingest/entity-upsert.service';

jest.mock('../src/db/surreal.service', () => ({
  __esModule: true,
  dbCreate: jest.fn(),
  retryOnUniqueViolation: (fn: () => unknown) => fn(),
  runTransaction: jest.fn(),
  isUniqueViolation: () => false,
}));

const mockDbCreate = dbCreate as jest.Mock;

function fakeDb(queryImpl: (sql: string, params: any) => unknown) {
  return { query: jest.fn(queryImpl) } as never;
}

describe('resolveOrCreateNamedEntity — user scope', () => {
  beforeEach(() => mockDbCreate.mockReset());

  const svc = new EntityUpsertService();
  const e = { name: 'Maria', type: 'customer' };

  it('scopes the canonical-name match to the user when userId is set', async () => {
    let capturedSql = '';
    let capturedParams: any = {};
    const db = fakeDb((sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [[{ id: 'knowledge_entity:maria_u' }]]; // match found
    });

    const id = await svc.resolveOrCreateNamedEntity({
      db,
      e,
      hint: undefined,
      _contextRef: { vertical: 'persona' },
      userId: 'user-7',
    });

    expect(id).toBe('knowledge_entity:maria_u');
    expect(capturedSql).toContain('userId = $scopeUserId');
    expect(capturedSql).not.toContain('userId IS NONE');
    expect(capturedParams.scopeUserId).toBe('user-7');
  });

  it('pins the global path to userId IS NONE when userId is omitted', async () => {
    let capturedSql = '';
    const db = fakeDb((sql) => {
      capturedSql = sql;
      return [[{ id: 'knowledge_entity:maria_global' }]];
    });

    const id = await svc.resolveOrCreateNamedEntity({
      db,
      e,
      hint: undefined,
      _contextRef: { vertical: 'persona' },
    });

    expect(id).toBe('knowledge_entity:maria_global');
    expect(capturedSql).toContain('userId IS NONE');
    expect(capturedSql).not.toContain('$scopeUserId');
  });

  it('stamps userId on a freshly-created entity (canonical miss)', async () => {
    const db = fakeDb(() => [[]]); // canonical miss
    mockDbCreate.mockResolvedValue({ id: 'knowledge_entity:new' });

    const id = await svc.resolveOrCreateNamedEntity({
      db,
      e,
      hint: undefined,
      _contextRef: { vertical: 'persona' },
      userId: 'user-7',
    });

    expect(id).toBe('knowledge_entity:new');
    const [, , content] = mockDbCreate.mock.calls[0];
    expect(content.userId).toBe('user-7');
  });

  it('does NOT stamp userId on a global create', async () => {
    const db = fakeDb(() => [[]]);
    mockDbCreate.mockResolvedValue({ id: 'knowledge_entity:new_global' });

    await svc.resolveOrCreateNamedEntity({
      db,
      e,
      hint: undefined,
      _contextRef: { vertical: 'persona' },
    });

    const [, , content] = mockDbCreate.mock.calls[0];
    expect(content.userId).toBeUndefined();
  });
});
