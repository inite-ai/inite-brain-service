import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EntityUpsertService } from '../ingest/entity-upsert.service';
import { FactResolverService } from '../ingest/fact-resolver.service';
import { createEdgeBetween } from '../ingest/edge-writer';
import {
  edgeTiming,
  factExpectation,
  factTiming,
  resolveEventTimeOpts,
} from '../ingest/event-time';
import { traceSpan } from '../common/debug-trace';
import { originKeyOf, StoredDocument } from './document-store.service';
import { internalMetaString, participantsFromMeta } from './document-meta';
import { coreferentParticipant, participantHint } from '../ingest/participants';
import { relativeHint } from '../ingest/relative-role';
import { sanitizeSourceMeta } from '../policy/source-meta';
import { sourceVersionFromHeader } from './document-meta';
import { incomingFactsFor, MergedFact, MergedRelation, MergeResult } from './candidate-merge';
import { EpisodeStoreService } from '../ingest/episode-store.service';
import { splitDocumentTurns, turnOfSpan, type DocumentTurn } from './document-turns';
import { idTailOf } from '../ingest/ingest-utils';

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

  // Nest DI: each collaborator is a constructor parameter; the episode
  // store is @Optional so positional unit fixtures stay valid.
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
    private readonly factResolver: FactResolverService,
    @Optional() private readonly episodes?: EpisodeStoreService,
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
      const turns = await this.commitTurns(db, p.companyId, p.doc);
      const facts = await this.writeFacts(db, {
        ...p,
        entityIds,
        turns,
        entityTypes: new Map(p.merge.entities.map((me) => [me.key, me.type])),
      });
      const relations = await this.writeRelations(db, { ...p, entityIds });
      return { entityIds, facts, relations };
    });
  }

  private async resolveEntities(
    db: Surreal,
    p: { doc: StoredDocument; merge: MergeResult },
  ): Promise<Map<string, string>> {
    const entityIds = new Map<string, string>();
    const participants = participantsFromMeta(p.doc.meta);
    // The judge (the ladder's slow rung, an LLM call per mention) is asked
    // for every mention at once; the ladder below still runs mention by
    // mention and consumes the answers in order. Once a mention CREATES an
    // entity the answers asked before it may be stale (a later mention may
    // be the one just created), so from then on the judge is asked live —
    // the outcome is exactly the sequential one.
    // A mention anchored by the caller (a record id, a participant) or pinned
    // by the extractor (`known`) is resolved before the judge's rung.
    const prejudged = new Map(
      p.merge.entities
        .filter(
          (me) => !me.externalId && !me.known && !coreferentParticipant(me.name, participants),
        )
        .map((me) => [
          me.key,
          this.entities.prejudge({ db, e: me, incomingFacts: incomingFactsFor(p.merge, me.key) }),
        ]),
    );
    let createdSince = false;
    for (const me of p.merge.entities) {
      const eid = await traceSpan(
        'brain.commit.entity',
        () =>
          this.entities.resolveOrCreateNamedEntity({
            db,
            e: { name: me.name, type: me.type, canonical: me.canonical, known: me.known },
            // Two anchors, most specific first. A system-of-record id names
            // WHICH entity this is (a CRM contact by its id, whatever it is
            // called today) and cannot be guessed from prose, so it wins when
            // the records door supplied one. Otherwise the participant this
            // mention corefers to (first person / the speaker's own name →
            // the speaker; second person / the addressee's name → the
            // addressee) anchors it to the caller's externalRef — the same
            // rule as the direct path (participants.ts), and the user's own
            // ref carries their scope.
            // A relative named by role is the speaker's own (relative-role.ts).
            hint: me.externalId
              ? { vertical: p.doc.vertical, id: me.externalId }
              : (participantHint(coreferentParticipant(me.name, participants), p.doc.userId) ??
                relativeHint(me, p.doc.userId)),
            _contextRef: { vertical: p.doc.vertical },
            incomingFacts: incomingFactsFor(p.merge, me.key),
            prejudged: createdSince ? undefined : prejudged.get(me.key),
            onStep: (step) => {
              if (step === 'created') createdSince = true;
            },
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
      /** The subject's extraction type, per entity key. */
      entityTypes: Map<string, string>;
      turns: CapturedTurns | null;
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
        const { validFrom, validUntil, objectMeta } = factTiming(mf, p.doc.occurredAt, timeOpts);
        // A value with a stated end carries no expectation (0166).
        const expectedUntil = validUntil
          ? undefined
          : factExpectation(mf.expectedEnd, p.doc.occurredAt, validFrom);
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
              validUntil,
              expectedUntil,
              objectMeta,
              supersedes: mf.supersedes,
              source: this.factSource(p.doc, mf, episodeOf(p.turns, mf)),
              entropy: mf.entropy,
              precomputedEmbedding: p.embeddings[i],
              // Per-user scope (0128): a user-scoped document's facts carry
              // its user — fn::resolve_fact stamps userId and the resolver
              // mirrors the 0093 scope tag, EXACTLY the direct mention
              // path's machinery (mention-persist passes dto.userId here).
              // Tenant-global docs leave it undefined — byte-identical.
              userId: p.doc.userId,
              // The subject's extraction type — read by the slot
              // canonicalization's non-person guard, as on the direct
              // path; absent, a guarded alias never reaches its slot.
              entityType: p.entityTypes.get(mf.entityKey),
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

  /**
   * The document's raw turns, captured when it ARRIVES — before any
   * extraction runs. The raw text is what the read lanes serve first
   * (episodic lane, segment windows, L3, verbatim quotes), and it used to
   * exist only after the extraction had finished and committed: a minute
   * later on a ten-kilobyte document, and never when the extraction
   * failed. The commit captures again and gets the same turns back (the
   * capture is idempotent), which is how its facts point at them.
   */
  async captureDocumentTurns(companyId: string, doc: StoredDocument): Promise<void> {
    await this.surreal.withCompany(companyId, (db) => this.captureTurns(db, companyId, doc));
  }

  /**
   * A document posted directly has no L0 turn behind it — only the
   * mention wrapper captures one — so every raw read lane (excerpts, raw
   * windows, grounding quotes, the episodic lane, L3 sessions) came back
   * empty for its facts. Its stored chunks are cut into turns and
   * captured as the conversation `document:<id>`; each fact is then
   * stamped with the turn its clause sits in. A wrapped mention keeps its
   * own turn; a document stored without content has no text to keep.
   */
  async captureTurns(
    db: Surreal,
    companyId: string,
    doc: StoredDocument,
  ): Promise<CapturedTurns | null> {
    return this.documentTurns(db, { companyId, doc, reuse: false });
  }

  /**
   * The turns a commit stamps its facts with: captured when the document
   * arrived, so their ids are read in one query; captured here only when
   * any is missing (a document stored before arrival captured its turns).
   */
  async commitTurns(
    db: Surreal,
    companyId: string,
    doc: StoredDocument,
  ): Promise<CapturedTurns | null> {
    return this.documentTurns(db, { companyId, doc, reuse: true });
  }

  private async documentTurns(
    db: Surreal,
    p: { companyId: string; doc: StoredDocument; reuse: boolean },
  ): Promise<CapturedTurns | null> {
    const { companyId, doc } = p;
    if (!this.episodes?.isEnabled() || !doc.hasContent) return null;
    if (internalMetaString(doc.meta, 'episodeId')) return null;
    try {
      const docRef = new StringRecordId(`source_document:${idTailOf(doc.id)}`);
      const [chunks, header] = await db.query<
        [Array<{ seq: number; text: string }>, Array<{ title?: string }>]
      >(
        `SELECT seq, text FROM source_chunk WHERE docId = $doc ORDER BY seq;
         SELECT title FROM $doc;`,
        { doc: docRef },
      );
      const turns = (chunks ?? []).flatMap((c) =>
        splitDocumentTurns(c.text).map((t) => ({ ...t, chunkSeq: c.seq })),
      );
      if (turns.length === 0) return null;
      const conversationId = `document:${idTailOf(doc.id)}`;
      const captured = p.reuse ? await capturedTurnIds(db, conversationId, turns.length) : null;
      if (captured) return { turns, ids: captured };
      const fallbackSpeaker = header?.[0]?.title ?? doc.vertical;
      // The mention path's own capture, one turn at a time: same row,
      // redaction, scope and idempotence — the unique (conversationId,
      // messageId) key makes a re-commit a no-op. Whole seconds apart so
      // every reader orders the conversation as it was written.
      const at = doc.occurredAt.getTime();
      const ids: Array<string | null> = [];
      for (const [i, t] of turns.entries()) {
        ids.push(
          await this.episodes.captureTurn(companyId, {
            text: t.text,
            emittedAt: new Date(at + i * 1000).toISOString(),
            contextRef: {
              vertical: doc.vertical,
              conversationId,
              messageId: `turn:${i}`,
              ...(doc.recorder ? { recorder: doc.recorder } : {}),
            },
            knownEntities: [
              {
                vertical: doc.vertical,
                id: conversationId,
                role: 'speaker',
                name: t.speaker ?? fallbackSpeaker,
              },
            ],
            ...(doc.userId !== undefined ? { userId: doc.userId } : {}),
          }),
        );
      }
      return { turns, ids };
    } catch (err) {
      this.logger.warn(`[brain.commit.turns] doc=${doc.id} failed: ${(err as Error).message}`);
      return null;
    }
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
              // Same scope as the document's facts (0055).
              userId: p.doc.userId,
              // Valid time (0164) against the same instant the facts use.
              ...edgeTiming(mr, p.doc.occurredAt),
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
  private factSource(
    doc: StoredDocument,
    mf: MergedFact,
    turnEpisodeId?: string | null,
  ): Record<string, unknown> {
    const { meta } = sanitizeSourceMeta(doc.meta);
    // The L0 turn the mention wrapper captured for this document — stamped
    // exactly as the direct path stamps it, so GET /v1/facts/:id/provenance
    // walks a document-path fact back to its episode too — else the
    // document's own turn the fact's clause sits in (captureTurns).
    const episodeId = internalMetaString(doc.meta, 'episodeId') ?? turnEpisodeId ?? undefined;
    return {
      vertical: doc.vertical,
      recorder: mf.recorder,
      documentId: doc.id,
      originKey: originKeyOf(doc.contentHash),
      ...(episodeId ? { episodeIds: [episodeId] } : {}),
      ...(meta ? { meta } : {}),
      ...sourceVersionOf(mf, doc),
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
        ...this.evidenceAssetEvidence(doc),
      ],
    };
  }

  /**
   * The evidence-bridge hop (EVIDENCE_DOCUMENT_BRIDGE): a document the
   * bridge created from a processor's text output carries the asset id
   * on its header, so every committed fact's evidence[] walks back to
   * the original bytes — asset → representation → document → fact. The
   * `ref` is the evidence_asset record id, which is what
   * parseRecordRef() dispatches on; the note names the representation
   * the text was read from. Same open-array precedent as the 0111 hop.
   */
  private evidenceAssetEvidence(doc: StoredDocument): Array<Record<string, unknown>> {
    const meta = doc.meta as Record<string, unknown> | undefined;
    const ref = meta?.['evidenceAssetId'];
    if (typeof ref !== 'string' || ref.length === 0) return [];
    const rep = meta?.['evidenceRepresentationId'];
    return [
      {
        kind: 'asset',
        ref,
        ...(typeof rep === 'string' && rep.length > 0 ? { note: `text via ${rep}` } : {}),
      },
    ];
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
export function sourceVersionOf(mf: MergedFact, doc?: StoredDocument): Record<string, unknown> {
  const leader = mf.contributors.find((c) => c.candidateId === mf.leaderId);
  const stamp =
    leader?.sourceVersion ??
    mf.contributors.find((c) => c.sourceVersion !== undefined)?.sourceVersion ??
    // Source plane: an in-process extraction has no candidate stamp, but
    // the document header carries the revision the connector read the
    // item at — every fact derived from it is bound to that revision.
    sourceVersionFromHeader(doc?.meta as Record<string, unknown> | undefined) ??
    undefined;
  return stamp ? { sourceVersion: stamp } : {};
}

export interface CapturedTurns {
  turns: Array<DocumentTurn & { chunkSeq: number }>;
  /** Aligned with `turns`; null where the turn was not stored. */
  ids: Array<string | null>;
}

/**
 * The stored turn a fact came from: its clause (a verbatim span, by the
 * grounding gate) looked up in its own chunk first, then anywhere in the
 * document. No match, no stamp — a guessed turn would be a false quote.
 */
function episodeOf(captured: CapturedTurns | null, mf: MergedFact): string | null {
  return episodeForSpans(captured, [mf.clause, mf.object], mf.leaderChunkSeq);
}

/** The stored turn holding the first of `spans` found — its own chunk first, then anywhere. */
export function episodeForSpans(
  captured: CapturedTurns | null,
  spans: Array<string | undefined>,
  chunkSeq?: number,
): string | null {
  if (!captured) return null;
  const own = captured.turns.filter((t) => t.chunkSeq === chunkSeq);
  for (const pool of [own, captured.turns]) {
    for (const span of spans) {
      const i = turnOfSpan(pool, span);
      if (i >= 0) return captured.ids[captured.turns.indexOf(pool[i]!)] ?? null;
    }
  }
  return null;
}

/**
 * The ids of a document's turns captured when it arrived, in turn order —
 * one read instead of capturing every turn again (a no-op write per turn
 * that answered the same ids). Null when any turn is missing (a document
 * stored before its turns were captured on arrival): the caller captures.
 */
async function capturedTurnIds(
  db: Surreal,
  conversationId: string,
  count: number,
): Promise<string[] | null> {
  const [rows] = await db.query<[Array<{ id: unknown; messageId?: string }>]>(
    `SELECT id, messageId FROM episode WHERE conversationId = $c AND kind = 'turn'`,
    { c: conversationId },
  );
  const byMessage = new Map((rows ?? []).map((r) => [r.messageId, String(r.id)]));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = byMessage.get(`turn:${i}`);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}
