/**
 * Unit-test for groundExternalBatch — server-side span re-validation for
 * external indexer submissions: entity names and fact values must appear
 * verbatim (normalized, word-boundary-aware) in the stored document text;
 * failures drop with reasons and survivors are re-indexed.
 */
import { groundExternalBatch } from '../src/documents/candidate-grounding';

const DOC = `Meeting notes.
Acme Corp confirmed the gold tier upgrade.
Maria will own the rollout in Berlin.`;

const entity = (name: string, entityIndex: number) => ({
  entityIndex,
  name,
  type: 'customer' as const,
});

describe('groundExternalBatch', () => {
  it('keeps grounded entities and facts, coordinates re-indexed', () => {
    const out = groundExternalBatch({
      docText: DOC,
      entities: [entity('Nonexistent Inc', 0), entity('Acme Corp', 1)],
      facts: [
        { entityIndex: 1, predicate: 'tier', object: 'gold', confidence: 0.9 },
      ],
      relations: [],
    });
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.name).toBe('Acme Corp');
    expect(out.entities[0]!.entityIndex).toBe(0); // compacted
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]!.entityIndex).toBe(0); // remapped 1 → 0
    expect(out.dropped).toEqual([
      expect.objectContaining({ kind: 'entity', reason: 'ungrounded_entity' }),
    ]);
  });

  it('drops a fact whose value never appears in the text', () => {
    const out = groundExternalBatch({
      docText: DOC,
      entities: [entity('Acme Corp', 0)],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'platinum', confidence: 0.9 },
      ],
      relations: [],
    });
    expect(out.facts).toHaveLength(0);
    expect(out.dropped).toEqual([
      expect.objectContaining({ kind: 'fact', reason: 'ungrounded_value' }),
    ]);
  });

  it('drops facts and relations of a dropped entity (orphan_reference)', () => {
    const out = groundExternalBatch({
      docText: DOC,
      entities: [entity('Ghost LLC', 0), entity('Maria', 1)],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 },
      ],
      relations: [
        { fromEntityIndex: 1, toEntityIndex: 0, kind: 'works_at', confidence: 0.8 },
      ],
    });
    expect(out.facts).toHaveLength(0);
    expect(out.relations).toHaveLength(0);
    expect(out.dropped.map((d) => d.reason).sort()).toEqual([
      'orphan_reference',
      'orphan_reference',
      'ungrounded_entity',
    ]);
  });

  it('grounding is whitespace/case-insensitive but word-boundary-aware', () => {
    const out = groundExternalBatch({
      docText: DOC,
      entities: [entity('acme   corp', 0), entity('Gol', 1)],
      facts: [],
      relations: [],
    });
    // Normalized match passes; "Gol" buried inside "gold" does not.
    expect(out.entities.map((e) => e.name)).toEqual(['acme   corp']);
  });
});
