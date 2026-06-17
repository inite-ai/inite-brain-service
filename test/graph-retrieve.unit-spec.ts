import {
  assembleGraphHits,
  GraphEntity,
  GraphFactRow,
} from '../src/search/internals/graph-retrieve';

const ent = (id: string, name: string, type = 'staff'): GraphEntity => ({
  entityId: id,
  canonicalName: name,
  type,
});

const fact = (
  factId: string,
  entityId: string,
  predicate: string,
  object: string,
  recordedAt = '2026-06-01T00:00:00Z',
): GraphFactRow => ({
  factId,
  entityId,
  predicate,
  object,
  confidence: 0.9,
  validFrom: '2026-01-01T00:00:00Z',
  status: 'active',
  recordedAt,
});

describe('assembleGraphHits — regression for the Acme/Maria case', () => {
  /**
   * The bug:
   *   query "who runs engineering at Acme"
   *     → chat router extracts subj=Acme, slot=status
   *     → graph-first resolves Acme, filters Acme's facts by predicate=status
   *     → Acme has NO status fact (the status is Maria's)
   *     → graph returns 0, falls back to vector, vector can't bridge
   *     → user sees ∅
   *
   * The fix: expand the seed set by its 1-hop neighbours, then filter
   * facts across {seeds ∪ neighbours}. Maria surfaces with her status
   * fact and the question is answered without leaving the graph.
   */
  it('seed has no hint-matching fact + neighbour does → neighbour surfaces', () => {
    const acme = ent('e_acme', 'Acme', 'project');
    const maria = ent('e_maria', 'Maria', 'staff');
    const entitiesById = new Map([
      ['e_acme', acme],
      ['e_maria', maria],
    ]);
    const factsByEntity = new Map<string, GraphFactRow[]>([
      ['e_acme', []], // Acme has no own facts under the hint
      ['e_maria', [fact('f1', 'e_maria', 'status', 'CTO at Acme')]],
    ]);

    const out = assembleGraphHits(
      ['e_acme'],
      entitiesById,
      factsByEntity,
      ['status'],
    );

    // Seed comes first (anchor), Maria as the neighbour with the hit.
    expect(out.map((r) => r.entityId)).toEqual(['e_acme', 'e_maria']);
    // Maria's fact is what answers the question.
    expect(out[1].facts).toHaveLength(1);
    expect(out[1].facts[0].predicate).toBe('status');
    expect(out[1].facts[0].object).toBe('CTO at Acme');
    // Seed is lifted higher than neighbour.
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('seed with no facts + neighbour with non-hint facts → neighbour DROPPED', () => {
    // Neighbour that has facts but none matching the predicate hint
    // should not pollute the result. Otherwise a popular hub entity
    // would dilute every query that names one of its neighbours.
    const acme = ent('e_acme', 'Acme', 'project');
    const bob = ent('e_bob', 'Bob', 'staff');
    const entitiesById = new Map([
      ['e_acme', acme],
      ['e_bob', bob],
    ]);
    const factsByEntity = new Map<string, GraphFactRow[]>([
      ['e_acme', []],
      ['e_bob', [fact('f1', 'e_bob', 'address', '4B')]], // not 'status'
    ]);

    const out = assembleGraphHits(
      ['e_acme'],
      entitiesById,
      factsByEntity,
      ['status'],
    );

    expect(out.map((r) => r.entityId)).toEqual(['e_acme']);
  });

  it('no hints — neighbour with ANY fact surfaces (recency mode)', () => {
    const acme = ent('e_acme', 'Acme', 'project');
    const bob = ent('e_bob', 'Bob', 'staff');
    const entitiesById = new Map([
      ['e_acme', acme],
      ['e_bob', bob],
    ]);
    const factsByEntity = new Map<string, GraphFactRow[]>([
      ['e_acme', []],
      ['e_bob', [fact('f1', 'e_bob', 'name', 'Bob Müller')]],
    ]);

    const out = assembleGraphHits(['e_acme'], entitiesById, factsByEntity, []);

    expect(out.map((r) => r.entityId)).toEqual(['e_acme', 'e_bob']);
  });

  it('seed always included even when it has zero facts', () => {
    // The UI needs the anchor entity to surface so the user sees the
    // entity was found. The trace then explains why no facts came back.
    const acme = ent('e_acme', 'Acme', 'project');
    const entitiesById = new Map([['e_acme', acme]]);
    const factsByEntity = new Map<string, GraphFactRow[]>([['e_acme', []]]);

    const out = assembleGraphHits(['e_acme'], entitiesById, factsByEntity, [
      'status',
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].entityId).toBe('e_acme');
    expect(out[0].facts).toEqual([]);
  });

  it('multiple seeds preserved in input order', () => {
    const acme = ent('e_acme', 'Acme', 'project');
    const beta = ent('e_beta', 'BetaCorp', 'project');
    const entitiesById = new Map([
      ['e_acme', acme],
      ['e_beta', beta],
    ]);
    const factsByEntity = new Map<string, GraphFactRow[]>([
      ['e_acme', [fact('f1', 'e_acme', 'name', 'Acme')]],
      ['e_beta', [fact('f2', 'e_beta', 'name', 'BetaCorp')]],
    ]);

    const out = assembleGraphHits(
      ['e_beta', 'e_acme'],
      entitiesById,
      factsByEntity,
      [],
    );

    expect(out.map((r) => r.entityId)).toEqual(['e_beta', 'e_acme']);
  });

  it('dedupes identical (predicate, object) facts, keeping most recent', () => {
    const maria = ent('e_maria', 'Maria', 'staff');
    const entitiesById = new Map([['e_maria', maria]]);
    const older = fact('f_old', 'e_maria', 'status', 'CTO', '2026-01-01T00:00:00Z');
    const newer = fact('f_new', 'e_maria', 'status', 'CTO', '2026-06-01T00:00:00Z');
    const factsByEntity = new Map<string, GraphFactRow[]>([
      ['e_maria', [older, newer]],
    ]);

    const out = assembleGraphHits(
      ['e_maria'],
      entitiesById,
      factsByEntity,
      ['status'],
    );

    expect(out[0].facts).toHaveLength(1);
    expect(out[0].facts[0].factId).toBe('f_new');
  });

  it('fact score is higher when predicate matches a hint', () => {
    const maria = ent('e_maria', 'Maria', 'staff');
    const entitiesById = new Map([['e_maria', maria]]);
    const factsByEntity = new Map<string, GraphFactRow[]>([
      [
        'e_maria',
        [
          fact('f1', 'e_maria', 'status', 'CTO'),
          fact('f2', 'e_maria', 'name', 'Maria Petrov'),
        ],
      ],
    ]);

    const out = assembleGraphHits(
      ['e_maria'],
      entitiesById,
      factsByEntity,
      ['status'],
    );

    const byPredicate = new Map(out[0].facts.map((f) => [f.predicate, f.score]));
    expect(byPredicate.get('status')).toBeGreaterThan(byPredicate.get('name')!);
  });

  it('unknown seed id (not in entitiesById) is skipped without crashing', () => {
    const out = assembleGraphHits(
      ['e_missing'],
      new Map(),
      new Map(),
      ['status'],
    );
    expect(out).toEqual([]);
  });
});
