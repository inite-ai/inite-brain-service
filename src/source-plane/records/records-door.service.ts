import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BUILTIN_PACKS, type DomainPackManifest } from '../../ai/domain-packs';
import { CORE_PREDICATES } from '../../ai/predicate-registry-internals/core-seed';
import { packMemoryProjectionsEnabled } from '../../common/pack-projection-flags';
import type { SourceVersionStamp } from '../../common/source-version';
import { SurrealService, queryFirst } from '../../db/surreal.service';
import { DocumentIngestService } from '../../documents/document-ingest.service';
import { internalDocumentMeta } from '../../documents/document-meta';
import { DOC_TEXT_HARD_CAP, type IngestDocumentDto } from '../../documents/dto/ingest-document.dto';
import type { SubmitCandidatesDto } from '../../documents/dto/submit-candidates.dto';
import { ExternalCandidatesService } from '../../documents/external-candidates.service';
import { RETRACT_ADMIN_PREDICATES } from '../../facts/facts.service';
import { policyFor } from '../../ingest/conflict-resolver';
import { idTailOf } from '../../ingest/ingest-utils';
import type { ConnectorConnectionView, ItemDescriptor, RecordEnvelope } from '../connector';
import {
  mapRecord,
  type EntityMapping,
  type MappedRecord,
  type Vocabulary,
} from './record-mapping';

/** `kind` on the grounding document a record becomes, and on a prose attribute's own document. */
export const SOURCE_RECORD_KIND = 'source_record';
export const SOURCE_RECORD_TEXT_KIND = 'source_record_text';

/** The scene a lifecycle claim rides on (crm_memory's memoryModel declares it). */
export const RECORD_UPDATE_SCENE = 'record_update';

export interface RecordsDoorOutcome {
  documentId: string;
  deduplicated: boolean;
  facts: number;
  relations: number;
  dropped: MappedRecord['dropped'];
}

interface PackVocabularyRow {
  manifest?: DomainPackManifest;
}

const VOCAB_TTL_MS = 60_000;

/**
 * RecordsDoorService — the `structure` door (docs/roadmap/crm-sources-
 * 2026-09.md § 4.1). A record enters as FACTS, not prose:
 *
 *   1. the envelope is rendered deterministically and stored as the
 *      grounding document (`source_record`) — with the pack-less general
 *      extractor switched OFF for it (`extraction: 'none'`): nothing
 *      here is for a model to read;
 *   2. the mapping (the connector's preset under the connection's own)
 *      turns attributes into candidates — the record's entity filed
 *      under its system-of-record id, one fact per mapped attribute,
 *      relation targets as entities of their own — submitted through
 *      the SAME external-candidates seam a remote indexer uses, so the
 *      verbatim grounding, the namespace fence, the run ledger and the
 *      commit apply unchanged (the render carries every value verbatim
 *      by construction);
 *   3. a lifecycle attribute becomes a `record_update` scene with a
 *      stateDelta when PACK_MEMORY_PROJECTIONS_ENABLED (the fact is
 *      always written; the projection is the bonus);
 *   4. prose attributes the mapping names (`notes`) become their own
 *      documents for the ordinary extractor — the budgeted exception.
 *
 * The pack that owns the connection must declare `indexer.mode:
 * 'external'` (crm_memory does): an in-process pack would extract the
 * render with a model, which is exactly what this door exists to avoid
 * — refused by name, not worked around.
 */
@Injectable()
export class RecordsDoorService {
  private readonly logger = new Logger(RecordsDoorService.name);
  private readonly vocab = new Map<string, { at: number; value: Vocabulary | null }>();

  constructor(
    private readonly documents: DocumentIngestService,
    private readonly candidates: ExternalCandidatesService,
    private readonly surreal: SurrealService,
  ) {}

  async ingest(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    record: RecordEnvelope;
    mapping: EntityMapping | undefined;
    stamp: SourceVersionStamp | null;
  }): Promise<RecordsDoorOutcome> {
    const vocab = await this.vocabularyFor(p.companyId, p.connection.packId);
    if (!vocab) {
      throw new BadRequestException(
        `pack "${p.connection.packId}" is not installed here — a record needs its pack's vocabulary`,
      );
    }
    const tail = idTailOf(p.connection.id);
    const mapped = mapRecord({
      record: p.record,
      mapping: p.mapping,
      vocab,
      idScope: (type, id) => `src_${tail}:${type}:${id}`,
    });
    const doc = await this.ingestText(p, {
      text: mapped.text,
      kind: SOURCE_RECORD_KIND,
      title: p.record.name,
      meta: { record_type: p.record.entityType.slice(0, 256) },
      extraction: 'none',
    });
    if (mapped.dropped.length > 0) {
      this.logger.warn(
        `[${p.connection.id}] ${p.record.entityType}/${p.record.externalId}: ${mapped.dropped
          .map((d) => `${d.key} (${d.reason})`)
          .join(', ')} not mapped`,
      );
    }
    if (!doc.deduplicated && (mapped.facts.length > 0 || mapped.relations.length > 0)) {
      await this.candidates.submit({
        companyId: p.companyId,
        docId: doc.documentId,
        dto: submissionOf(p.connection.packId, mapped, p.record),
      });
      // The controller's second half: commit once every run of the
      // document is terminal (it is — the render had no other reader).
      const commit = await this.documents.commitIfSettled(p.companyId, doc.documentId);
      if (commit && !commit.committed && !commit.deferred) {
        this.logger.warn(
          `[${p.connection.id}] ${p.item.externalId}: candidates staged, commit pending`,
        );
      }
    }
    for (const field of mapped.textFields) {
      await this.ingestText(p, {
        text: field.value.slice(0, DOC_TEXT_HARD_CAP),
        kind: SOURCE_RECORD_TEXT_KIND,
        title: `${p.record.name} — ${field.key}`,
        meta: {
          record_type: p.record.entityType.slice(0, 256),
          record_field: field.key.slice(0, 64),
        },
        extraction: 'general',
      });
    }
    return {
      documentId: doc.documentId,
      deduplicated: doc.deduplicated,
      facts: mapped.facts.length,
      relations: mapped.relations.length,
      dropped: mapped.dropped,
    };
  }

  /** The pack's vocabulary — its predicates, its state models, and the core predicates an external indexer may seed. */
  async vocabularyFor(companyId: string, packId: string): Promise<Vocabulary | null> {
    const key = `${companyId}/${packId}`;
    const cached = this.vocab.get(key);
    if (cached && Date.now() - cached.at < VOCAB_TTL_MS) return cached.value;
    const manifest = await this.manifestOf(companyId, packId);
    const value = manifest ? vocabularyOf(manifest) : null;
    this.vocab.set(key, { at: Date.now(), value });
    return value;
  }

  private async manifestOf(companyId: string, packId: string): Promise<DomainPackManifest | null> {
    const builtin = BUILTIN_PACKS.find((m) => m.id === packId);
    if (builtin) return builtin;
    const row = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<PackVocabularyRow>(
        db,
        `SELECT manifest FROM domain_pack WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId },
      ),
    );
    return row?.manifest ?? null;
  }

  private async ingestText(
    p: {
      companyId: string;
      connection: ConnectorConnectionView;
      itemId: string;
      item: ItemDescriptor;
      record: RecordEnvelope;
      stamp: SourceVersionStamp | null;
    },
    d: {
      text: string;
      kind: string;
      title: string;
      meta: Record<string, string>;
      extraction: 'general' | 'none';
    },
  ): Promise<{ documentId: string; deduplicated: boolean }> {
    const occurredAt = toIso(p.record.updatedAt ?? p.item.modifiedAt);
    const dto: IngestDocumentDto = {
      kind: d.kind,
      text: d.text,
      originUri: p.item.originUri ?? `source://${idTailOf(p.connection.id)}/${p.item.externalId}`,
      title: d.title.slice(0, 512),
      occurredAt,
      ...(p.connection.userId ? { userId: p.connection.userId } : {}),
      contextRef: { vertical: p.connection.vertical, recorder: p.connection.recorder },
      meta: {
        source_connection: idTailOf(p.connection.id),
        source_pack: p.connection.packId,
        source_id: p.connection.sourceId,
        ...d.meta,
      },
      storeContent: true,
      mode: 'sync',
      // The render goes to the pack (external mode: no in-process
      // extraction, the candidates below are its facts); a prose field
      // goes to the general pipeline.
      ...(d.extraction === 'none' ? { indexers: [p.connection.packId] } : {}),
    };
    const internal = internalDocumentMeta({
      sourceConnectionId: p.connection.id,
      sourceItemId: p.itemId,
      ...(p.stamp
        ? {
            sourceVersionSystem: p.stamp.system,
            sourceVersionRef: p.stamp.ref,
            sourceVersionValue: p.stamp.version,
            sourceVersionReadAt: p.stamp.readAt,
          }
        : {}),
    });
    const r = await this.documents.ingestDocument(p.companyId, dto, {
      channel: 'source',
      internal,
      extraction: d.extraction,
    });
    return { documentId: r.documentId, deduplicated: r.deduplicated === true };
  }
}

/** The candidate batch for one mapped record — confidence 1: nothing here was guessed. */
export function submissionOf(
  packId: string,
  mapped: MappedRecord,
  record: RecordEnvelope,
): SubmitCandidatesDto {
  const projections = packMemoryProjectionsEnabled() && mapped.stateDelta !== null;
  return {
    indexerId: packId,
    entities: mapped.entities.map((e) => ({
      name: e.name,
      type: e.type,
      externalId: e.externalId,
    })),
    facts: mapped.facts.map((f) => ({
      entityIndex: f.entityIndex,
      predicate: f.predicate,
      object: f.object,
      confidence: 1,
    })),
    relations: mapped.relations.map((r) => ({
      fromEntityIndex: r.fromEntityIndex,
      toEntityIndex: r.toEntityIndex,
      kind: r.kind,
      confidence: 1,
    })),
    ...(projections && mapped.stateDelta
      ? {
          scenes: [
            {
              schemaId: RECORD_UPDATE_SCENE,
              label: `${record.entityType} ${record.name} → ${mapped.stateDelta.to}`.slice(0, 200),
              gist: mapped.text.slice(0, 2000),
              ...(record.updatedAt
                ? { occurredFrom: record.updatedAt, occurredTo: record.updatedAt }
                : {}),
            },
          ],
          stateDeltas: [
            {
              sceneIndex: 0,
              stateModelId: mapped.stateDelta.model,
              subject: record.name.slice(0, 256),
              to: mapped.stateDelta.to,
            },
          ],
        }
      : {}),
  };
}

/** Exposed for tests. */
export function vocabularyOf(manifest: DomainPackManifest): Vocabulary {
  const core = new Set<string>();
  for (const p of CORE_PREDICATES) {
    if (RETRACT_ADMIN_PREDICATES.has(p.predicateId)) continue;
    if (policyFor(p.predicateId).requiresScope) continue;
    core.add(p.predicateId);
  }
  return {
    packId: manifest.id,
    localIds: new Set(manifest.predicates.map((p) => p.localId)),
    corePredicates: core,
    stateModels: new Map(
      (manifest.memoryModel?.stateModels ?? []).map((m) => [m.id, new Set(m.states)]),
    ),
  };
}

function toIso(v: string | undefined): string {
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
