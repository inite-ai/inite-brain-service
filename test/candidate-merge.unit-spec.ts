/**
 * Unit-test for mergeCandidates — the pure half of CommitMemory: entity
 * unification across runs/chunks, cross-indexer fact folding (confidence
 * = MAX, never boosted — same-document indexers are not independent
 * evidence), relation dedupe, orphan rejection.
 */
import { mergeCandidates } from '../src/documents/candidate-merge';
import type { CandidateRow } from '../src/documents/candidate-store.service';

let seq = 0;
const row = (p: {
  kind: 'entity' | 'fact' | 'relation';
  runId?: string;
  chunkSeq?: number;
  confidence?: number;
  payload: Record<string, unknown>;
}): CandidateRow => ({
  id: `candidate:c${seq++}`,
  runId: p.runId ?? 'indexer_run:r1',
  chunkSeq: p.chunkSeq ?? 0,
  kind: p.kind,
  confidence: p.confidence ?? 0.7,
  status: 'pending',
  payload: p.payload,
});

const entity = (name: string, entityIndex: number, extra: Record<string, unknown> = {}) =>
  row({
    kind: 'entity',
    payload: { entityIndex, name, type: 'customer', indexerId: '_general' },
    ...extra,
  });

beforeEach(() => {
  seq = 0;
});

describe('mergeCandidates', () => {
  it('unifies the same entity across two runs into one', () => {
    const rows = [
      entity('Acme Corp', 0, { runId: 'indexer_run:r1' }),
      entity('acme corp', 0, { runId: 'indexer_run:r2' }),
    ];
    const out = mergeCandidates(rows);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.candidateIds).toHaveLength(2);
  });

  it('folds a bare-name entity with a canonical-bearing one via alias union', () => {
    // Indexer A: name only. Indexer B: same entity, name differs but its
    // canonical matches A's name. They must land in ONE entity, and a fact
    // from each must fold into one merged fact.
    const rows = [
      row({
        kind: 'entity',
        runId: 'indexer_run:rA',
        payload: { entityIndex: 0, name: 'acme corp', type: 'customer' },
      }),
      row({
        kind: 'entity',
        runId: 'indexer_run:rB',
        payload: {
          entityIndex: 0,
          name: 'ACME Corporation',
          canonical: 'Acme Corp',
          type: 'customer',
        },
      }),
      row({
        kind: 'fact',
        runId: 'indexer_run:rA',
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: '_general' },
      }),
      row({
        kind: 'fact',
        runId: 'indexer_run:rB',
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'crm' },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]!.candidateIds).toHaveLength(2);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]!.contributors).toHaveLength(2);
    expect(out.rejected).toHaveLength(0);
  });

  it('keeps distinct entities distinct (different type or name)', () => {
    const rows = [
      entity('Acme', 0),
      row({
        kind: 'entity',
        payload: { entityIndex: 1, name: 'Acme', type: 'project', indexerId: '_general' },
      }),
    ];
    expect(mergeCandidates(rows).entities).toHaveLength(2);
  });

  it('folds the same fact from two indexers into ONE with confidence=max', () => {
    const rows = [
      entity('Acme', 0, { runId: 'indexer_run:r1' }),
      entity('Acme', 0, { runId: 'indexer_run:r2' }),
      row({
        kind: 'fact',
        runId: 'indexer_run:r1',
        confidence: 0.6,
        payload: {
          entityIndex: 0,
          predicate: 'works_at',
          object: 'Berlin office',
          indexerId: 'core',
        },
      }),
      row({
        kind: 'fact',
        runId: 'indexer_run:r2',
        confidence: 0.9,
        payload: {
          entityIndex: 0,
          predicate: 'works_at',
          object: 'Berlin  office ', // whitespace-normalized duplicate
          indexerId: 'meetings',
        },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.facts).toHaveLength(1);
    const f = out.facts[0]!;
    expect(f.confidence).toBe(0.9); // max, not noisy-or
    expect(f.recorder).toBe('meetings'); // leader's indexer
    expect(f.contributors).toHaveLength(2);
    expect(f.mergedIds).toHaveLength(1);
  });

  it('different objects stay separate facts', () => {
    const rows = [
      entity('Acme', 0),
      row({
        kind: 'fact',
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
      row({
        kind: 'fact',
        payload: { entityIndex: 0, predicate: 'tier', object: 'silver', indexerId: 'core' },
      }),
    ];
    expect(mergeCandidates(rows).facts).toHaveLength(2);
  });

  it('rejects a fact whose entityIndex has no entity (orphan)', () => {
    const rows = [
      row({
        kind: 'fact',
        payload: { entityIndex: 5, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.facts).toHaveLength(0);
    expect(out.rejected).toEqual([
      expect.objectContaining({ kind: 'fact', reason: 'orphan_entity' }),
    ]);
  });

  it('entityIndex scope is per (run, chunk) — same index in another chunk is another entity', () => {
    const rows = [
      entity('Acme', 0, { chunkSeq: 0 }),
      row({
        kind: 'entity',
        chunkSeq: 1,
        payload: { entityIndex: 0, name: 'Globex', type: 'customer', indexerId: '_general' },
      }),
      row({
        kind: 'fact',
        chunkSeq: 1,
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.entities).toHaveLength(2);
    const globexKey = out.entities.find((e) => e.name === 'Globex')!.key;
    expect(out.facts[0]!.entityKey).toBe(globexKey);
  });

  it('dedupes relations by (from, to, kind) and rejects self-loops', () => {
    const rows = [
      entity('Acme', 0),
      row({
        kind: 'entity',
        payload: { entityIndex: 1, name: 'Maria', type: 'staff', indexerId: '_general' },
      }),
      row({
        kind: 'relation',
        confidence: 0.5,
        payload: { fromEntityIndex: 1, toEntityIndex: 0, kind: 'works_at', indexerId: '_general' },
      }),
      row({
        kind: 'relation',
        confidence: 0.8,
        payload: { fromEntityIndex: 1, toEntityIndex: 0, kind: 'works_at', indexerId: '_general' },
      }),
      row({
        kind: 'relation',
        payload: { fromEntityIndex: 0, toEntityIndex: 0, kind: 'self', indexerId: '_general' },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]!.confidence).toBe(0.8);
    expect(out.rejected).toEqual([
      expect.objectContaining({ kind: 'relation', reason: 'orphan_relation' }),
    ]);
  });

  it('cross-chunk duplicate of the same fact folds (overlap dedupe)', () => {
    const rows = [
      entity('Acme', 0, { chunkSeq: 0 }),
      entity('Acme', 0, { chunkSeq: 1 }),
      row({
        kind: 'fact',
        chunkSeq: 0,
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
      row({
        kind: 'fact',
        chunkSeq: 1,
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
    ];
    const out = mergeCandidates(rows);
    expect(out.facts).toHaveLength(1);
    expect(out.entities).toHaveLength(1);
  });

  it('ignores 0110 episodic kinds byte-identically (scene/state_delta are inert here)', () => {
    // The semantic mergers dispatch on kind and skip everything else —
    // pinned so widening the candidate enum can never leak episodic rows
    // into the graph-commit path, NOT EVEN as rejections.
    const semantic = [
      entity('Acme Corp', 0),
      row({
        kind: 'fact',
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
    ];
    const baseline = mergeCandidates(semantic);
    seq = 0; // re-issue the same candidate ids for the mixed run
    const mixed = mergeCandidates([
      entity('Acme Corp', 0),
      row({
        kind: 'fact',
        payload: { entityIndex: 0, predicate: 'tier', object: 'gold', indexerId: 'core' },
      }),
      {
        id: 'candidate:scene1',
        runId: 'indexer_run:r1',
        chunkSeq: 0,
        kind: 'scene',
        confidence: 0.7,
        status: 'pending',
        payload: { sceneIndex: 0, schemaId: 'viewing', label: 'L', gist: 'G' },
      },
      {
        id: 'candidate:delta1',
        runId: 'indexer_run:r1',
        chunkSeq: 0,
        kind: 'state_delta',
        confidence: 0.7,
        status: 'pending',
        payload: { sceneIndex: 0, stateModelId: 'deal', subject: 's', to: 'open' },
      },
    ]);
    expect(mixed).toEqual(baseline);
    expect(mixed.rejected).toHaveLength(0);
  });
});
