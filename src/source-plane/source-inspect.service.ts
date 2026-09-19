import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  SourceConnectionStats,
  SourceItemAsset,
  SourceItemDocument,
  SourceItemEpisode,
  SourceItemFact,
  SourceItemInspectResponse,
} from '../contracts/source-plane/source-plane.schema';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { toItemView, type SourceItemRow } from './source-item.service';

type Db = Parameters<Parameters<SurrealService['withCompany']>[1]>[0];

/** Facts shown per item; one more is read to know there were more. */
const FACTS_PAGE = 50;
/** Bridged parts of one binary item that are followed to their facts. */
const DOCUMENTS_MAX = 20;
/** A count over the fact table is a scan — bounded, and "null" past the bound. */
const SCAN_TIMEOUT = '5s';
/** The turn's text shown in the drawer, at most. */
const EPISODE_TEXT_MAX = 4000;

/**
 * SourceInspectService — the operator's drill-down over what a
 * connection produced: catalogue rows by state and the facts the
 * connection grounds (stats), and one item followed all the way —
 * the document it became (or the asset and the bridge's parts), the
 * representations the processors extracted, and the facts that cite
 * it with what the drift sweep sees on each (the revision they were
 * read at, stale marks, closes).
 *
 * Reads only. Fact and document lookups by provenance are scans (no
 * index on `source.documentId` / `source.meta.source_connection` —
 * the same shape the gone policy walks); every one is bounded by a
 * page and a query timeout, and a count that times out is reported
 * as null rather than a failure.
 */
@Injectable()
export class SourceInspectService {
  private readonly logger = new Logger(SourceInspectService.name);

  constructor(private readonly surreal: SurrealService) {}

  async stats(companyId: string, connectionId: string): Promise<SourceConnectionStats> {
    const tail = idTailOf(connectionId);
    return this.surreal.withCompany(companyId, async (db) => {
      const byState = await queryRows<{ state: string; n: number }>(
        db,
        `SELECT state, count() AS n FROM source_item WHERE connectionId = type::record('source_connection', $tail) GROUP BY state`,
        { tail },
      );
      const items = { seen: 0, fetched: 0, indexed: 0, gone: 0, total: 0 };
      for (const r of byState) {
        if (r.state in items) items[r.state as keyof typeof items] = r.n;
        items.total += r.n;
      }
      return { connectionId, items, facts: await this.factCounts(db, tail) };
    });
  }

  private async factCounts(db: Db, tail: string): Promise<SourceConnectionStats['facts']> {
    try {
      const row = await queryFirst<{ active: number; stale: number; closed: number }>(
        db,
        // The doors label every fact's source with the connection tail
        // (source.meta.source_connection) so ABAC and this count agree.
        `SELECT
            count(validUntil IS NONE AND status = 'active') AS active,
            count(validUntil IS NONE AND status = 'active' AND staleAt IS NOT NONE) AS stale,
            count(validUntil IS NOT NONE) AS closed
           FROM knowledge_fact
          WHERE source.meta.source_connection = $tail
          GROUP ALL TIMEOUT ${SCAN_TIMEOUT}`,
        { tail },
      );
      return {
        active: row?.active ?? 0,
        stale: row?.stale ?? 0,
        closed: row?.closed ?? 0,
      };
    } catch (e) {
      this.logger.warn(`fact count for connection ${tail} skipped: ${(e as Error).message}`);
      return null;
    }
  }

  async item(
    companyId: string,
    p: { connectionId: string; itemId: string },
  ): Promise<SourceItemInspectResponse> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<SourceItemRow>(
        db,
        `SELECT * FROM type::record('source_item', $tail)`,
        { tail: idTailOf(p.itemId) },
      );
      // The item must belong to the connection named in the URL — a
      // tenant's items are one table, and the row id alone would let
      // one connection's drawer open another's.
      if (!row || String(row.connectionId) !== p.connectionId) {
        throw new NotFoundException('source item not found');
      }
      const item = toItemView(row);
      const documents = await this.documentsOf(db, row);
      const asset = row.assetId ? await this.assetOf(db, row.assetId) : null;
      const episode = row.episodeId ? await this.episodeOf(db, row.episodeId) : null;
      const { facts, truncated } = await this.factsOf(db, [
        ...documents.map((d) => ({ documentId: d.id })),
        ...(episode ? [{ episodeId: episode.id }] : []),
      ]);
      return { item, documents, asset, episode, facts, factsTruncated: truncated };
    });
  }

  /** The document a text item became, or the parts the bridge made of a binary one. */
  private async documentsOf(db: Db, row: SourceItemRow): Promise<SourceItemDocument[]> {
    const projection = `id, title, kind, status, originUri, createdAt`;
    if (row.documentId) {
      const doc = await queryFirst<RawDocument>(
        db,
        `SELECT ${projection} FROM type::record('source_document', $tail)`,
        { tail: idTailOf(row.documentId) },
      );
      return doc ? [toDocument(doc)] : [];
    }
    if (!row.assetId) return [];
    try {
      const tail = idTailOf(row.assetId);
      const docs = await queryRows<RawDocument>(
        db,
        `SELECT ${projection} FROM source_document
          WHERE meta.evidenceAssetId IN $ids
          ORDER BY createdAt ASC LIMIT ${DOCUMENTS_MAX} TIMEOUT ${SCAN_TIMEOUT}`,
        { ids: [row.assetId, `evidence_asset:${tail}`, tail] },
      );
      return docs.map(toDocument);
    } catch (e) {
      this.logger.warn(`bridged documents of ${row.assetId} skipped: ${(e as Error).message}`);
      return [];
    }
  }

  private async assetOf(db: Db, assetId: string): Promise<SourceItemAsset | null> {
    const tail = idTailOf(assetId);
    const asset = await queryFirst<RawAsset>(
      db,
      `SELECT id, mediaType, modality, byteLength, availability, quarantineStatus FROM type::record('evidence_asset', $tail)`,
      { tail },
    );
    if (!asset) return null;
    const reps = await queryRows<RawRepresentation>(
      db,
      `SELECT id, kind, producerVersion, string::len(content ?? '') AS chars, createdAt
         FROM derived_representation
        WHERE subjectId = type::record('evidence_asset', $tail) AND supersededBy IS NONE
        ORDER BY createdAt ASC LIMIT 50`,
      { tail },
    );
    return {
      id: String(asset.id),
      mediaType: asset.mediaType,
      modality: asset.modality,
      byteLength: asset.byteLength,
      availability: asset.availability,
      quarantineStatus: asset.quarantineStatus ?? null,
      representations: reps.map((r) => ({
        id: String(r.id),
        kind: r.kind,
        producerVersion: r.producerVersion,
        chars: r.chars ?? 0,
        createdAt: toIso(r.createdAt),
      })),
    };
  }

  /** The turn a conversation-shaped item was captured as (the mention door's episode). */
  private async episodeOf(db: Db, episodeId: string): Promise<SourceItemEpisode | null> {
    try {
      const row = await queryFirst<RawEpisode>(
        db,
        `SELECT id, conversationId, messageId, speaker, text, occurredAt
           FROM type::record('episode', $tail)`,
        { tail: idTailOf(episodeId) },
      );
      if (!row) return null;
      return {
        id: String(row.id),
        conversationId: row.conversationId ?? null,
        messageId: row.messageId ?? null,
        speaker: row.speaker ?? null,
        text: (row.text ?? '').slice(0, EPISODE_TEXT_MAX),
        occurredAt: toIso(row.occurredAt),
      };
    } catch (e) {
      this.logger.warn(`episode ${episodeId} skipped: ${(e as Error).message}`);
      return null;
    }
  }

  /** The facts a document grounds (`source.documentId`) or an episode turn yielded (`source.episodeIds`). */
  private async factsOf(
    db: Db,
    refs: Array<{ documentId: string } | { episodeId: string }>,
  ): Promise<{ facts: SourceItemFact[]; truncated: boolean }> {
    const facts: SourceItemFact[] = [];
    let truncated = false;
    for (const ref of refs) {
      if (facts.length > FACTS_PAGE) break;
      const byDocument = 'documentId' in ref;
      try {
        const rows = await queryRows<RawFact>(
          db,
          // 3.x: an ORDER BY field must be in the projection.
          `SELECT id, entityId, predicate, object, confidence, status, recordedAt,
                  source.sourceVersion.version AS version, staleAt, staleReason, validUntil
             FROM knowledge_fact
            WHERE ${byDocument ? 'source.documentId = $ref' : 'source.episodeIds CONTAINS $ref'}
            ORDER BY recordedAt ASC LIMIT ${FACTS_PAGE + 1} TIMEOUT ${SCAN_TIMEOUT}`,
          { ref: byDocument ? ref.documentId : ref.episodeId },
        );
        for (const r of rows) facts.push(toFact(r));
      } catch (e) {
        this.logger.warn(
          `facts of ${byDocument ? ref.documentId : ref.episodeId} skipped: ${(e as Error).message}`,
        );
        truncated = true;
      }
    }
    if (facts.length > FACTS_PAGE) {
      truncated = true;
      facts.length = FACTS_PAGE;
    }
    return { facts, truncated };
  }
}

interface RawEpisode {
  id: unknown;
  conversationId?: string | null;
  messageId?: string | null;
  speaker?: string | null;
  text?: string | null;
  occurredAt?: unknown;
}

interface RawDocument {
  id: unknown;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  originUri?: string | null;
  createdAt?: unknown;
}

interface RawAsset {
  id: unknown;
  mediaType: string;
  modality: string;
  byteLength: number;
  availability: string;
  quarantineStatus?: string | null;
}

interface RawRepresentation {
  id: unknown;
  kind: string;
  producerVersion: string;
  chars?: number | null;
  createdAt?: unknown;
}

interface RawFact {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  confidence: number;
  status: string;
  version?: string | null;
  staleAt?: unknown;
  staleReason?: string | null;
  validUntil?: unknown;
}

function toDocument(d: RawDocument): SourceItemDocument {
  return {
    id: String(d.id),
    title: d.title ?? null,
    kind: d.kind ?? null,
    status: d.status ?? null,
    originUri: d.originUri ?? null,
    createdAt: toIso(d.createdAt),
  };
}

function toFact(r: RawFact): SourceItemFact {
  return {
    id: String(r.id),
    entityId: String(r.entityId),
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    version: r.version ?? null,
    staleAt: toIso(r.staleAt),
    staleReason: r.staleReason ?? null,
    validUntil: toIso(r.validUntil),
    status: r.status,
  };
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
