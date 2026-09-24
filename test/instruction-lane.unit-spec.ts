/**
 * InstructionLaneService (src/synthesize/instruction-lane.service.ts):
 * the T7 read is one fenced predicate query, not a search.
 *  - predicate (or alias) = instruction, active, unretracted;
 *  - PII gate off the caller's scopes, fail-closed user gate;
 *  - the ABAC row verdict applies; texts are deduplicated and capped;
 *  - any failure degrades to [].
 */
import { InstructionLaneService } from '../src/synthesize/instruction-lane.service';

function make(rows: Array<Record<string, unknown>> | Error) {
  const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    query: jest.fn(async (sql: string, params: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (rows instanceof Error) throw rows;
      return [rows];
    }),
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  };
  const registry = {
    rowPolicyLookup: async () => (predicate: string) =>
      predicate === 'instruction' ? { requiresScope: undefined } : { requiresScope: 'brain:admin' },
  };
  return { svc: new InstructionLaneService(surreal as never, registry as never), queries };
}

const row = (object: string, extra: Record<string, unknown> = {}) => ({
  id: `knowledge_fact:${object.length}`,
  predicate: 'instruction',
  object,
  validFrom: '2026-09-14T12:00:00Z',
  ...extra,
});

describe('InstructionLaneService.instructionLines', () => {
  it('reads the instruction predicate with the PII and user fences, newest first', async () => {
    const { svc, queries } = make([
      row('Always answer in Portuguese.'),
      row('Write reports for Boomerang in Portuguese.'),
    ]);
    const out = await svc.instructionLines({ companyId: 'co', callerScopes: [], userId: 'u1' });
    expect(out).toEqual([
      'Always answer in Portuguese.',
      'Write reports for Boomerang in Portuguese.',
    ]);
    const q = queries[0]!;
    expect(q.sql).toContain('predicate = $predicate OR predicateAlias = $predicate');
    expect(q.sql).toContain("status = 'active' AND retractedAt IS NONE");
    expect(q.sql).toContain('AND piiClass IS NONE');
    expect(q.sql).toContain('userId IS NONE OR userId = $scopeUserId');
    expect(q.sql).toContain('ORDER BY validFrom DESC');
    expect(q.params).toMatchObject({ predicate: 'instruction', scopeUserId: 'u1' });
  });

  it('a PII-scoped caller reads PII rows; no user ⇒ tenant-global rows only', async () => {
    const { svc, queries } = make([]);
    await svc.instructionLines({ companyId: 'co', callerScopes: ['brain:read_pii'] });
    expect(queries[0]!.sql).not.toContain('piiClass');
    expect(queries[0]!.sql).toContain('AND userId IS NONE');
    expect(queries[0]!.params).not.toHaveProperty('scopeUserId');
  });

  it('deduplicates on the text (case-insensitively), drops blanks, caps at eight', async () => {
    const rows = [
      row('  Keep it short.  '),
      row('keep it short.'),
      row('   '),
      ...Array.from({ length: 10 }, (_, i) => row(`Rule ${i}`)),
    ];
    const out = await make(rows).svc.instructionLines({ companyId: 'co', callerScopes: [] });
    expect(out[0]).toBe('Keep it short.');
    expect(out).toHaveLength(8);
    expect(new Set(out.map((t) => t.toLowerCase())).size).toBe(8);
  });

  it('the ABAC row verdict filters what the caller may not see', async () => {
    const { svc } = make([row('secret', { predicate: 'instruction_admin' }), row('public')]);
    // The registry stub requires brain:admin for any predicate but 'instruction'.
    const out = await svc.instructionLines({ companyId: 'co', callerScopes: [] });
    expect(out).toEqual(['public']);
  });

  it('degrades to [] when the read fails', async () => {
    const { svc } = make(new Error('db down'));
    await expect(svc.instructionLines({ companyId: 'co', callerScopes: [] })).resolves.toEqual([]);
  });
});
