import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import type {
  RecordsPreviewRequest,
  RecordsPreviewResponse,
} from '../../contracts/source-plane/source-plane.schema';
import { idTailOf } from '../../ingest/ingest-utils';
import {
  SOURCE_CONNECTORS,
  findConnector,
  type ConnectorCtx,
  type ConnectorRegistry,
  type RecordEnvelope,
} from '../connector';
import { CredentialProvider } from '../oauth/credential-provider';
import { mapRecord, mergeMappings, type RecordMapping, type Vocabulary } from './record-mapping';
import { RecordsConnector, type RecordsConnectionConfig } from './records-connector';
import { RecordsDoorService } from './records-door.service';

const DEFAULT_LIMIT = 5;

/**
 * RecordsPreviewService — "nothing is committed until the preview ran"
 * (docs/roadmap/crm-sources-2026-09.md § 4.3): with the config and
 * credential an operator is about to connect, list ONE page per chosen
 * entity at the live vendor, run the mapping over the first records
 * and show what they would become — the facts, the relations, the
 * fields left unmapped — without a connection, a catalogue row or a
 * document. Read-only at the vendor; nothing is written here.
 */
@Injectable()
export class RecordsPreviewService {
  constructor(
    private readonly door: RecordsDoorService,
    private readonly credentials: CredentialProvider,
    @Optional() @Inject(SOURCE_CONNECTORS) private readonly connectors?: ConnectorRegistry,
  ) {}

  async preview(companyId: string, req: RecordsPreviewRequest): Promise<RecordsPreviewResponse> {
    const packId = req.packId;
    const vocab = await this.door.vocabularyFor(companyId, packId);
    if (!vocab) throw new BadRequestException(`pack "${packId}" is not installed here`);
    const connector = findConnector(this.connectors ?? [], connectorOf(req));
    if (!(connector instanceof RecordsConnector)) {
      throw new BadRequestException(`source "${req.sourceId}" has no records connector to preview`);
    }
    const cfg = (req.config ?? {}) as RecordsConnectionConfig;
    const credential = await this.credentials.resolve(companyId, req.credential ?? null);
    const ctx: ConnectorCtx = {
      companyId,
      connection: {
        id: 'source_connection:preview',
        packId,
        sourceId: req.sourceId,
        kind: 'native',
        connector: connector.kind,
        shape: 'structure',
        host: 'server',
        config: cfg as Record<string, unknown>,
        credential,
        credentialSource: credential
          ? req.credential?.startsWith('oauth:')
            ? 'grant'
            : 'secret'
          : null,
        contentPolicy: 'text',
        vertical: 'preview',
        recorder: 'preview',
        userId: null,
      },
      signal: AbortSignal.timeout(30_000),
      log: () => undefined,
    };
    const mapping: RecordMapping = mergeMappings(connector.preset, cfg.mapping);
    const limit = req.limit ?? DEFAULT_LIMIT;
    const selected = connector.selectedEntities(cfg);
    // Every entity's first page is listed BEFORE any record is named, so a
    // deal's contact listed later in the same preview still gets its name
    // from the run cache — as it does in a real run, where the whole
    // enumerate precedes the fetches. One run, ended once.
    const pages = new Map<string, RecordEnvelope[] | Error>();
    try {
      for (const entity of selected) {
        try {
          const page = await connector.list(ctx, entity.type, { since: null, page: null });
          connector.remember(ctx, page.records);
          pages.set(entity.type, page.records);
        } catch (e) {
          pages.set(entity.type, e as Error);
        }
      }
      const entities: RecordsPreviewResponse['entities'] = [];
      for (const entity of selected) {
        const listed = pages.get(entity.type);
        if (listed instanceof Error || !listed) {
          entities.push({
            type: entity.type,
            label: entity.label,
            records: [],
            error: listed?.message ?? 'not listed',
          });
          continue;
        }
        const named: RecordEnvelope[] = [];
        for (const r of listed.slice(0, limit)) named.push(await connector.named(ctx, r));
        entities.push({
          type: entity.type,
          label: entity.label,
          records: named.map((record) =>
            previewOf({ record, mapping, entity: entity.type, vocab, ctx }),
          ),
          error: null,
        });
      }
      return { entities };
    } finally {
      await connector.endRun?.(ctx).catch(() => undefined);
    }
  }
}

/** One record as the preview shows it: the facts and relations the mapping yields, the fields it leaves, the drops by name. */
function previewOf(p: {
  record: RecordEnvelope;
  mapping: RecordMapping;
  entity: string;
  vocab: Vocabulary;
  ctx: ConnectorCtx;
}): RecordsPreviewResponse['entities'][number]['records'][number] {
  const m = mapRecord({
    record: p.record,
    mapping: p.mapping[p.entity],
    vocab: p.vocab,
    idScope: (t, id) => `src_${idTailOf(p.ctx.connection.id)}:${t}:${id}`,
  });
  const mappedKeys = new Set(Object.keys(p.mapping[p.entity]?.fields ?? {}));
  return {
    record: p.record,
    facts: m.facts.map((f) => ({ predicate: f.predicate, object: f.object })),
    relations: m.relations.map((r) => ({
      kind: r.kind,
      target: m.entities[r.toEntityIndex]?.name ?? '',
    })),
    unmapped: Object.keys(p.record.attributes).filter((k) => !mappedKeys.has(k)),
    dropped: m.dropped,
  };
}

/** The connector a preview runs — by the pack entry's connector name, which the catalogue already resolved for the form. */
function connectorOf(req: RecordsPreviewRequest): string {
  const named = (req.config as { connector?: unknown } | undefined)?.connector;
  return typeof named === 'string' ? named : req.sourceId;
}
