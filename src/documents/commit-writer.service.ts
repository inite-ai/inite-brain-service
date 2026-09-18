import { Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EntityUpsertService } from '../ingest/entity-upsert.service';
import { FactResolverService } from '../ingest/fact-resolver.service';
import { createEdgeBetween } from '../ingest/edge-writer';
import { factTiming, resolveEventTimeOpts } from '../ingest/event-time';
import { traceSpan } from '../common/debug-trace';
import { originKeyOf, StoredDocument } from './document-store.service';
import { internalMetaString } from './document-meta';
import {
  isFirstPersonSelfReference,
  isSecondPersonReference,
  matchesParticipantName,
} from '../common/coreference';
import { sanitizeSourceMeta } from '../policy/source-meta';
import { incomingFactsFor, MergedFact, MergedRelation, MergeResult } from './candidate-merge';

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
    const speaker = participantOf(p.doc, 'speaker');
    const addressee = participantOf(p.doc, 'addressee');
    for (const me of p.merge.entities) {
      const eid = await traceSpan(
        'brain.commit.entity',
        () =>
          this.entities.resolveOrCreateNamedEntity({
            db,
            e: { name: me.name, type: me.type, canonical: me.canonical, known: me.known },
            // The participant this mention corefers to (first person /
            // the speaker's own name → the speaker; second person / the
            // addressee's name → the addressee) anchors it to the
            // caller's externalRef — the direct path's hintFor rule.
            hint: hintFor(me.name, speaker, addressee),
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
    // The speaker's session timezone rides the internal document channel
    // (mention-via-document); a document posted directly has none.
    const timeOpts = resolveEventTimeOpts(internalMetaString(p.doc.meta, 'timezone'));
    for (const [i, mf] of p.factsToWrite.entries()) {
      const entityId = p.entityIds.get(mf.entityKey);
      if (!entityId) {
        outcomes.push({ fact: mf, factId: null, outcome: null });
        continue;
      }
      // Per-fact isolation, mirroring writeRelations: one poison fact
      // (a value fn::resolve_fact rejects non-retriably) must not fail
      // the whole commit_document job terminally — that stranded the
      // already-written half, left every candidate status pending, and
      // had the sweeper re-arm the same failing commit forever. The
      // pipeline's own motto: one broken pack must not hold a document's
      // memory hostage.
      try {
        // The day the extractor resolved, else the occurrence date the
        // clause names, else the document's time — the same rule, from
        // the same function, as the direct mention path. This used to be
        // `p.doc.occurredAt` unconditionally, which stamped every fact a
        // stock deployment ingests with the day it was SAID.
        const { validFrom, objectMeta } = factTiming(mf, p.doc.occurredAt, timeOpts);
        const { result } = await traceSpan(
          'brain.commit.fact',
          () =>
            this.factResolver.resolve(db, {
              companyId: p.companyId,
              entityId,
              predicate: mf.predicate,
              object: mf.object,
              confidence: mf.confidence,
              validFrom,
              objectMeta,
              supersedes: mf.supersedes,
              source: this.factSource(p.doc, mf),
              entropy: mf.entropy,
              precomputedEmbedding: p.embeddings[i],
              // Per-user scope (0128): a user-scoped document's facts carry
              // its user — fn::resolve_fact stamps userId and the resolver
              // mirrors the 0093 scope tag, EXACTLY the direct mention
              // path's machinery (mention-persist passes dto.userId here).
              // Tenant-global docs leave it undefined — byte-identical.
              userId: p.doc.userId,
            }),
          { predicate: mf.predicate, entityId },
        );
        outcomes.push({
          fact: mf,
          factId: result?.factId ? String(result.factId) : null,
          outcome: result?.outcome ? String(result.outcome) : null,
        });
      } catch (err) {
        this.logger.warn(
          `[brain.commit.fact] predicate=${mf.predicate} entity=${entityId} failed: ${(err as Error).message}`,
        );
        outcomes.push({ fact: mf, factId: null, outcome: 'error' });
      }
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
        this.logger.warn(`[brain.commit.edge] kind=${mr.kind} failed: ${(err as Error).message}`);
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
    // The L0 turn the mention wrapper captured for this document. Stamped
    // exactly as the direct path stamps it, so GET /v1/facts/:id/provenance
    // walks a document-path fact back to its episode too.
    const episodeId = internalMetaString(doc.meta, 'episodeId');
    return {
      vertical: doc.vertical,
      recorder: mf.recorder,
      documentId: doc.id,
      originKey: originKeyOf(doc.contentHash),
      ...(episodeId ? { episodeIds: [episodeId] } : {}),
      ...(meta ? { meta } : {}),
      ...sourceVersionOf(mf),
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
        ...this.toolObservationEvidence(doc),
      ],
    };
  }

  /**
   * The 0111 provenance hop: when the ingest path validated + stored a
   * toolObservationRef on the document header (see
   * DocumentIngestService.threadToolObservation), every committed fact's
   * evidence[] carries the tool_observation entry alongside the document
   * one — tool result → document → fact, no schema change (evidence is
   * an open array inside FLEXIBLE source). Content-free: ref + a
   * '<tool> @ <iso>' note.
   */
  private toolObservationEvidence(doc: StoredDocument): Array<Record<string, unknown>> {
    const meta = doc.meta as Record<string, unknown> | undefined;
    const ref = meta?.['toolObservationRef'];
    if (typeof ref !== 'string' || ref.length === 0) return [];
    const note = meta?.['toolObservationNote'];
    return [
      {
        kind: 'tool_observation',
        ref,
        ...(typeof note === 'string' ? { note } : {}),
      },
    ];
  }
}

/**
 * The source-version hop (PACK_SOURCE_VERSION_STALENESS): a derivable
 * claim is bound to the revision of the external system of record it was
 * read at, so `source.sourceVersion` says "at commit abc123" and the
 * drift sweep has something to compare against. FLEXIBLE `source` is the
 * natural home — no migration, exactly the `evidence[]`/`meta`
 * precedent.
 *
 * The LEADER's stamp wins, because the leader is the reading the fact's
 * value came from; a corroborating contributor from another run may have
 * read a different commit and its stamp would misdescribe this value.
 * Falls back to any contributor carrying one only when the leader has
 * none. Returns `{}` — not a null key — when nothing carries a stamp, so
 * the flag-off `source` object is byte-identical.
 */
export function sourceVersionOf(mf: MergedFact): Record<string, unknown> {
  const leader = mf.contributors.find((c) => c.candidateId === mf.leaderId);
  const stamp =
    leader?.sourceVersion ??
    mf.contributors.find((c) => c.sourceVersion !== undefined)?.sourceVersion;
  return stamp ? { sourceVersion: stamp } : {};
}

/**
 * A turn participant off the internal document channel (the mention
 * wrapper threads `knownEntities` by role as name + `vertical:id`).
 */
function participantOf(
  doc: StoredDocument,
  role: 'speaker' | 'addressee',
): { vertical: string; id: string; role: string; name?: string | undefined } | undefined {
  const ref = internalMetaString(doc.meta, role === 'speaker' ? 'speakerRef' : 'addresseeRef');
  if (!ref) return undefined;
  const cut = ref.indexOf(':');
  if (cut <= 0 || cut === ref.length - 1) return undefined;
  return {
    vertical: ref.slice(0, cut),
    id: ref.slice(cut + 1),
    role,
    name: internalMetaString(doc.meta, role === 'speaker' ? 'speakerName' : 'addresseeName'),
  };
}

/** The direct path's coreference rule (MentionPersistService.hintFor). */
function hintFor(
  name: string,
  speaker: ReturnType<typeof participantOf>,
  addressee: ReturnType<typeof participantOf>,
): ReturnType<typeof participantOf> {
  if (speaker && (isFirstPersonSelfReference(name) || matchesParticipantName(name, speaker.name))) {
    return speaker;
  }
  if (
    addressee &&
    (isSecondPersonReference(name) || matchesParticipantName(name, addressee.name))
  ) {
    return addressee;
  }
  return undefined;
}
