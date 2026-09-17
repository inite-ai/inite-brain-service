/**
 * CommitWriterService.factSource — the provenance hops on every committed
 * fact's `source.evidence[]`: the document entry always, the 0111
 * tool-observation entry when the header carries one, and the
 * evidence-bridge asset entry (EVIDENCE_DOCUMENT_BRIDGE) when the
 * document was bridged from a processor's text output. The internal
 * header keys never leak into the projected `source.meta`.
 */
import { CommitWriterService } from '../src/documents/commit-writer.service';
import type { StoredDocument } from '../src/documents/document-store.service';
import type { MergeResult, MergedFact } from '../src/documents/candidate-merge';
import type { SurrealService } from '../src/db/surreal.service';
import type { EntityUpsertService } from '../src/ingest/entity-upsert.service';
import type { FactResolverService } from '../src/ingest/fact-resolver.service';

function doc(meta: Record<string, unknown> | undefined): StoredDocument {
  return {
    id: 'source_document:d1',
    kind: 'evidence_text',
    contentHash: 'abc',
    charLen: 10,
    chunkCount: 1,
    hasContent: true,
    vertical: 'contracts',
    recorder: 'upload_bot',
    occurredAt: new Date('2026-03-01T10:00:00.000Z'),
    status: 'indexed',
    meta,
  } as StoredDocument;
}

const FACT: MergedFact = {
  entityKey: 'e1',
  predicate: 'rent_due',
  object: 'monthly',
  confidence: 0.9,
  recorder: 'legal',
  leaderId: 'candidate:c1',
  leaderChunkSeq: 0,
  mergedIds: ['candidate:c1'],
  contributors: [
    {
      indexerId: 'legal',
      packVersion: '1.0.0',
      model: 'm',
      confidence: 0.9,
      candidateId: 'candidate:c1',
    },
  ],
} as MergedFact;

async function commitOne(meta: Record<string, unknown> | undefined) {
  const resolve = jest.fn(async () => ({
    result: { factId: 'knowledge_fact:f1', outcome: 'INSERTED' },
  }));
  const svc = new CommitWriterService(
    {
      withCompany: (_c: string, fn: (db: unknown) => unknown) => fn({}),
    } as unknown as SurrealService,
    {
      resolveOrCreateNamedEntity: async () => 'knowledge_entity:e1',
    } as unknown as EntityUpsertService,
    { resolve } as unknown as FactResolverService,
  );
  const merge: MergeResult = {
    entities: [{ key: 'e1', name: 'Lease 9', type: 'contract', canonical: 'lease 9' }],
    facts: [FACT],
    relations: [],
    rejected: [],
  } as unknown as MergeResult;
  await svc.writeMerged({
    companyId: 'co_1',
    doc: doc(meta),
    merge,
    factsToWrite: [FACT],
    embeddings: [],
  });
  expect(resolve).toHaveBeenCalledTimes(1);
  return (resolve.mock.calls[0] as unknown as [unknown, { source: Record<string, unknown> }])[1]
    .source;
}

describe('CommitWriterService — evidence[] provenance hops', () => {
  it('a plain document carries only the document entry', async () => {
    const source = await commitOne({ data_class: 'contract' });
    expect(source.evidence).toEqual([
      { kind: 'document', ref: 'source_document:d1', note: 'chunk 0' },
    ]);
    expect(source.meta).toEqual({ data_class: 'contract' });
  });

  it('a bridged document adds the asset hop and keeps the header keys out of meta', async () => {
    const source = await commitOne({
      evidence_bridge: true,
      evidenceAssetId: 'evidence_asset:a1',
      evidenceRepresentationId: 'derived_representation:r1',
    });
    expect(source.evidence).toEqual([
      { kind: 'document', ref: 'source_document:d1', note: 'chunk 0' },
      { kind: 'asset', ref: 'evidence_asset:a1', note: 'text via derived_representation:r1' },
    ]);
    expect(source.meta).toEqual({ evidence_bridge: true });
  });

  it('tool-observation and asset hops coexist, in header order', async () => {
    const source = await commitOne({
      toolObservationRef: 'tool_observation:t1',
      toolObservationNote: 'crm_lookup @ 2026-03-01T10:00:00.000Z',
      evidenceAssetId: 'evidence_asset:a1',
    });
    expect((source.evidence as Array<{ kind: string }>).map((e) => e.kind)).toEqual([
      'document',
      'tool_observation',
      'asset',
    ]);
    expect(source.evidence).toContainEqual({ kind: 'asset', ref: 'evidence_asset:a1' });
  });
});
