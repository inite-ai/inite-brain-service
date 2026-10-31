/**
 * memory_diff's default text (src/mcp/diff-view.ts): a replaced value is
 * one chain line, a restatement and a compaction summary add nothing,
 * and the learned facts are spent the focus view's way — the facts or
 * their turn, whichever is cheaper, and the window's turns outright when
 * they cost less than the whole structured answer.
 */
import { diffText, type DiffSources } from '../src/mcp/diff-view';
import type { FactRef, MemoryDiffResult } from '../src/diff/memory-diff.service';

let n = 0;
function fact(over: Partial<FactRef>): FactRef {
  n += 1;
  return {
    factId: `knowledge_fact:f${n}`,
    entityId: 'knowledge_entity:ls',
    entityName: 'ledger-sync',
    predicate: 'runtime',
    object: 'Node 22',
    confidence: 0.9,
    validFrom: '2026-03-02T09:00:00.000Z',
    recordedAt: '2026-10-31T00:00:00.000Z',
    status: 'active',
    ...over,
  };
}

function diff(over: Partial<MemoryDiffResult>): MemoryDiffResult {
  return {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-12-31T00:00:00.000Z',
    createdFacts: [],
    retractedFacts: [],
    changedFacts: [],
    newEntities: [],
    forgottenEntities: [],
    lapsedExpectations: [],
    truncated: false,
    ...over,
  };
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('memory_diff text', () => {
  it('a replaced value is one chain line; restatements and compaction summaries add nothing', () => {
    const text = diffText(
      diff({
        createdFacts: [
          fact({
            predicate: 'queue_backend',
            object: 'Redis Streams',
            validUntil: '2026-03-18T09:35:00.000Z',
            status: 'compacted',
          }),
          fact({
            predicate: 'queue_backend',
            object: 'NATS JetStream',
            validFrom: '2026-03-18T09:35:00.000Z',
          }),
          fact({
            predicate: 'queue_backend',
            object: 'NATS JetStream',
            validFrom: '2026-03-18T10:30:00.000Z',
            status: 'corroborating',
          }),
          fact({
            predicate: 'summary_queue_backend',
            object: '[2026-03-02] queue_backend: Redis Streams',
            sourceKind: 'compaction-summary',
          }),
        ],
      }),
    );
    expect(text).toContain(
      'ledger-sync — queue_backend: Redis Streams (2026-03-02) → NATS JetStream (2026-03-18)',
    );
    expect(text.match(/NATS JetStream/g)).toHaveLength(1);
    expect(text).not.toContain('summary_queue_backend');
  });

  it('values that hold together are joined, not chained', () => {
    const text = diffText(
      diff({
        createdFacts: [
          fact({ predicate: 'code_memory__invariant', object: 'no config files in the image' }),
          fact({ predicate: 'code_memory__invariant', object: 'never dual-write to the queue' }),
        ],
      }),
    );
    expect(text).not.toContain('changed:');
    expect(text).toContain(
      'ledger-sync: code_memory__invariant = no config files in the image; code_memory__invariant = never dual-write to the queue',
    );
  });

  it('a turn that entails its facts and costs less stands in for them', () => {
    const a = fact({ predicate: 'runtime', object: 'Node 22 with TypeScript and strict mode on' });
    const b = fact({ predicate: 'package_manager', object: 'pnpm, pinned through corepack' });
    const c = fact({
      entityName: 'meridian',
      predicate: 'vendor_type',
      object: 'upstream bank API vendor',
      validFrom: '2026-03-10T09:00:00.000Z',
    });
    const turn = {
      episodeId: 'episode:t1',
      text: 'ledger-sync: Node 22, TypeScript strict, pnpm via corepack.',
      at: '2026-03-02T09:00:00.000Z',
      speaker: 'Argus',
    };
    const ctx: DiffSources = {
      sources: new Map([
        [a.factId, [turn]],
        [b.factId, [turn]],
      ]),
      entailed: new Set([a.factId, b.factId]),
      tokens,
    };
    const text = diffText(diff({ createdFacts: [a, b, c] }), ctx);
    expect(text).toContain('Argus: "ledger-sync: Node 22, TypeScript strict, pnpm via corepack."');
    expect(text).not.toContain('package_manager');
    // No turn behind it: the fact stands, under its day.
    expect(text).toMatch(/2026-03-10\n {4}meridian: vendor_type = upstream bank API vendor/);
  });

  it('a turn its facts are not entailed by is never quoted for them', () => {
    const a = fact({ predicate: 'package_manager', object: 'pnpm' });
    const other = fact({ entityName: 'meridian', predicate: 'region', object: 'eu-west-1' });
    const turn = {
      episodeId: 'episode:t1',
      text: 'We went with the usual one, and the region is in our runbook somewhere.',
      at: '2026-03-02T09:00:00.000Z',
    };
    const ctx: DiffSources = {
      sources: new Map([[a.factId, [turn]]]),
      entailed: new Set(),
      tokens,
    };
    const text = diffText(diff({ createdFacts: [a, other] }), ctx);
    expect(text).toContain('ledger-sync: package_manager = pnpm');
  });

  it('the window’s turns are the answer when they cost less than the facts restating them', () => {
    const facts = [
      fact({ predicate: 'started_by', object: 'Argus' }),
      fact({ predicate: 'project_type', object: 'payment-reconciliation worker' }),
      fact({ predicate: 'decision_source_of_truth', object: 'this memory' }),
    ];
    const turn = {
      episodeId: 'episode:t1',
      text: 'Argus here: kicking off ledger-sync, a payout reconciler; this memory decides.',
      at: '2026-03-02T09:00:00.000Z',
      speaker: 'Argus',
    };
    const ctx: DiffSources = {
      sources: new Map(facts.map((f) => [f.factId, [turn]])),
      // Not entailed one by one, so no per-turn quote; the turns as a
      // whole are still the raw these facts came from.
      entailed: new Set(),
      tokens,
    };
    const text = diffText(diff({ createdFacts: facts }), ctx);
    expect(text).toContain('said (the turns are shorter than their facts):');
    expect(text).toContain('Argus: "Argus here: kicking off ledger-sync');
    expect(text).not.toContain('started_by');
  });

  it('retractions, new and forgotten entities, lapsed expectations and truncation are said', () => {
    const text = diffText(
      diff({
        retractedFacts: [
          fact({ predicate: 'cutoff', object: '16:30', retractedAt: '2026-03-25T10:00:00.000Z' }),
        ],
        newEntities: [
          {
            entityId: 'knowledge_entity:m',
            type: 'org',
            canonicalName: 'meridian',
            externalRefs: {},
            createdAt: '2026-03-02T00:00:00.000Z',
          },
        ],
        forgottenEntities: [{ entityIdHash: 'h', reason: 'gdpr', forgottenAt: '2026-04-01' }],
        lapsedExpectations: [
          fact({
            entityName: 'Priya',
            predicate: 'status',
            object: 'ill',
            expectedUntil: '2026-04-02T00:00:00.000Z',
          }),
        ],
        truncated: true,
      }),
    );
    expect(text).toContain('retracted:\n  ledger-sync: cutoff = 16:30 (2026-03-25)');
    expect(text).toContain('new: meridian');
    expect(text).toContain('forgotten: 1 entities (erased on request)');
    expect(text).toContain('  Priya: status = ill (until 2026-04-02)');
    expect(text).toContain('(truncated: narrow the window to see the rest)');
  });

  it('an empty window says so', () => {
    expect(diffText(diff({}))).toBe('changes recorded 2026-01-01 → 2026-12-31:\n  (none)');
  });
});
