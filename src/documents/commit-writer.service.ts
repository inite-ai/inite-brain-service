import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EntityUpsertService } from '../ingest/entity-upsert.service';
import { FactResolverService } from '../ingest/fact-resolver.service';
import { createEdgeBetween } from '../ingest/edge-writer';
import { traceSpan } from '../common/debug-trace';
import { originKeyOf, StoredDocument } from './document-store.service';
import { sanitizeSourceMeta } from '../policy/source-meta';
import {
  incomingFactsFor,
  MergedFact,
  MergedRelation,
  MergeResult,
} from './candidate-merge';

export interface FactWriteOutcome {
  fact: MergedFact;
  factId: string | null;
  outcome: string | null;
}

export interface RelationWriteOutcome {
  relation: MergedRelation;
  edgeId: string | null;
}

export interface WriteMergedResult {
  /** entityKey → knowledge_entity id */
  entityIds: Map<string, string>;
  facts: FactWriteOutcome[];
  relations: RelationWriteOutcome[];
}

/**
 * Graph-write half of CommitMemory: drive merged candidates through the
 * SAME write primitives the mention path uses — entity resolution via
 * EntityUpsertService, facts via FactResolverService/fn::resolve_fact
 * (reject / corroborate / supersede / compete decisions live THERE, not
 * here), edges via the shared createEdgeBetween. This service adds only
 * the document-shaped `source`:
 *
 *   recorder  = the indexer that read the claim (per-indexer trust)
 *   originKey = 'doc:' + contentHash (corroboration independence, 0050)
 *   indexers  = full contributor provenance from the cross-indexer merge
 */
@Injectable()
export class CommitWriterService {
  private readonly logger = new Logger(CommitWriterService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    private readonly factResolver: FactResolverService,
  ) {}

  async writeMerged(p: {
    companyId: string;
    doc: StoredDocument;
    merge: MergeResult;
    /** Facts that survived the confidence prefilter, in write order. */
    factsToWrite: MergedFact[];
    /** Aligned with factsToWrite; [] falls back to per-fact embedding. */
    embeddings: number[][];
  }): Promise<WriteMergedResult> {
    return this.surreal.withCompany(p.companyId, async (db) => {
      const entityIds = await this.resolveEntities(db, p);
      const facts = await this.writeFacts(db, { ...p, entityIds });
      const relations = await this.writeRelations(db, { ...p, entityIds });
      return { entityIds, facts, relations };
    });
  }

  private async resolveEntities(
    db: Surreal,
    p: { doc: StoredDocument; merge: MergeResult },
  ): Promise<Map<string, string>> {
    const entityIds = new Map<string, string>();
    for (const me of p.merge.entities) {
      const eid = await traceSpan(
        'brain.commit.entity',
        () =>
          this.entities.resolveOrCreateNamedEntity({
            db,
            e: { name: me.name, type: me.type, canonical: me.canonical },
            hint: undefined,
            _contextRef: { vertical: p.doc.vertical },
            incomingFacts: incomingFactsFor(p.merge, me.key),
          }),
        { name: me.name, type: me.type },
      );
      entityIds.set(me.key, eid);
    }
    return entityIds;
  }

  private async writeFacts(
    db: Surreal,
    p: {
      companyId: string;
      doc: StoredDocument;
      factsToWrite: MergedFact[];
      embeddings: number[][];
      entityIds: Map<string, string>;
    },
  ): Promise<FactWriteOutcome[]> {
    const outcomes: FactWriteOutcome[] = [];
    for (let i = 0; i < p.factsToWrite.length; i++) {
      const mf = p.factsToWrite[i];
      const entityId = p.entityIds.get(mf.entityKey);
      if (!entityId) {
        outcomes.push({ fact: mf, factId: null, outcome: null });
        continue;
      }
      const { result } = await traceSpan(
        'brain.commit.fact',
        () =>
          this.factResolver.resolve(db, {
            companyId: p.companyId,
            entityId,
            predicate: mf.predicate,
            object: mf.object,
            confidence: mf.confidence,
            validFrom: p.doc.occurredAt,
            source: this.factSource(p.doc, mf),
            entropy: mf.entropy,
            precomputedEmbedding: p.embeddings[i],
          }),
        { predicate: mf.predicate, entityId },
      );
      outcomes.push({
        fact: mf,
        factId: result?.factId ? String(result.factId) : null,
        outcome: result?.outcome ? String(result.outcome) : null,
      });
    }
    return outcomes;
  }

  private async writeRelations(
    db: Surreal,
    p: {
      doc: StoredDocument;
      merge: MergeResult;
      entityIds: Map<string, string>;
    },
  ): Promise<RelationWriteOutcome[]> {
    const outcomes: RelationWriteOutcome[] = [];
    for (const mr of p.merge.relations) {
      const fromId = p.entityIds.get(mr.fromKey);
      const toId = p.entityIds.get(mr.toKey);
      if (!fromId || !toId || fromId === toId) {
        outcomes.push({ relation: mr, edgeId: null });
        continue;
      }
      try {
        const edgeId = await traceSpan(
          'brain.commit.edge',
          () =>
            createEdgeBetween(db, {
              fromEntityId: fromId,
              toEntityId: toId,
              kind: mr.kind,
              source: {
                vertical: p.doc.vertical,
                documentId: p.doc.id,
                originKey: originKeyOf(p.doc.contentHash),
                confidence: mr.confidence,
              },
            }),
          { kind: mr.kind, from: fromId, to: toId },
        );
        outcomes.push({ relation: mr, edgeId });
      } catch (err) {
        this.logger.warn(
          `[brain.commit.edge] kind=${mr.kind} failed: ${(err as Error).message}`,
        );
        outcomes.push({ relation: mr, edgeId: null });
      }
    }
    return outcomes;
  }

  /**
   * The document-shaped fact source. Opaque to fn::resolve_fact except
   * for the keys it derives: source_key_of reads vertical+recorder,
   * origin_key_of reads originKey (0050). `indexers` and `evidence` are
   * provenance for audit/read paths. `meta` is the Zep-style projection:
   * the document's operator metadata rides onto every derived fact so
   * ABAC `source.meta.*` rules can match at read time (sanitized —
   * snake_case keys, short scalars, ≤16 entries).
   */
  private factSource(doc: StoredDocument, mf: MergedFact): Record<string, unknown> {
    const { meta } = sanitizeSourceMeta(doc.meta);
    return {
      vertical: doc.vertical,
      recorder: mf.recorder,
      documentId: doc.id,
      originKey: originKeyOf(doc.contentHash),
      ...(meta ? { meta } : {}),
      indexers: mf.contributors.map((c) => ({
        packId: c.indexerId,
        packVersion: c.packVersion,
        model: c.model,
        confidence: c.confidence,
        candidateId: c.candidateId,
      })),
      evidence: [
        {
          kind: 'document',
          ref: doc.id,
          note: `chunk ${mf.leaderChunkSeq}`,
        },
      ],
    };
  }
}
