/**
 * Read-side query expansion: the pure merge (alt-only rows join the
 * pool pre-tagged 'query_expansion', shared rows keep max cosine) and
 * the service's off-by-default / no-key gates.
 */
import { ConfigService } from '@nestjs/config';
import { mergeVectorRows } from '../src/search/internals/legs';
import type { FactRow } from '../src/search/internals/types';
import { QueryExpansionService } from '../src/ai/query-expansion.service';

function row(id: string, simScore: number): FactRow {
  return {
    id,
    entityId: 'knowledge_entity:e',
    predicate: 'status',
    object: 'active',
    confidence: 0.9,
    validFrom: '2026-01-01T00:00:00Z',
    recordedAt: '2026-07-01T00:00:00Z',
    status: 'active',
    source: {},
    simScore,
  } as FactRow;
}

describe('mergeVectorRows', () => {
  it('keeps max cosine for shared facts, tags alt-only facts', () => {
    const primary = [row('knowledge_fact:a', 0.9), row('knowledge_fact:b', 0.4)];
    const alt = [row('knowledge_fact:b', 0.8), row('knowledge_fact:c', 0.7)];

    const merged = mergeVectorRows(primary, alt);
    const byId = new Map(merged.map((r) => [String(r.id), r]));

    expect(merged).toHaveLength(3);
    // Shared fact upgraded to the better cosine, no expansion tag.
    expect(byId.get('knowledge_fact:b')?.simScore).toBe(0.8);
    expect(byId.get('knowledge_fact:b')?.stages ?? []).not.toContain(
      'query_expansion',
    );
    // Alt-only fact joins pre-tagged so DecisionLog can attribute it.
    expect(byId.get('knowledge_fact:c')?.stages).toEqual(['query_expansion']);
    // Primary-only fact untouched.
    expect(byId.get('knowledge_fact:a')?.simScore).toBe(0.9);
  });

  it('never downgrades a primary cosine', () => {
    const merged = mergeVectorRows(
      [row('knowledge_fact:a', 0.9)],
      [row('knowledge_fact:a', 0.2)],
    );
    expect(merged[0].simScore).toBe(0.9);
  });
});

describe('QueryExpansionService gates', () => {
  it('returns [] when the flag is off', async () => {
    const svc = new QueryExpansionService(
      new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
    );
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.expand('anything')).toEqual([]);
  });

  it('returns [] without an OpenAI key even when flagged on', async () => {
    // Explicit empty key — ConfigService would otherwise fall through to
    // a developer machine's process.env.OPENAI_API_KEY.
    const svc = new QueryExpansionService(
      new ConfigService({
        SEARCH_QUERY_EXPANSION_ENABLED: '1',
        OPENAI_API_KEY: '',
      }),
    );
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.expand('anything')).toEqual([]);
  });
});
