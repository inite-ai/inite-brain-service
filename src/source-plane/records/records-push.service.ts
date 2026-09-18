import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  PushRecordsRequest,
  PushRecordsResponse,
} from '../../contracts/source-plane/source-plane.schema';
import { JobRunService } from '../../jobs/job-run.service';
import { SourceConnectionService, type SourceConnectionRow } from '../source-connection.service';
import { SourceGonePolicyService } from '../source-gone-policy.service';
import { SourceItemEffectsService } from '../source-item-effects.service';
import { SourceItemService } from '../source-item.service';
import { mergeMappings, type RecordMapping } from './record-mapping';
import { describeRecord, itemIdOf } from './records-connector';

/**
 * RecordsPushService — the push transport (docs/roadmap/crm-sources-
 * 2026-09.md § 4.1): a CRM's outbound webhook, an automation (Make,
 * n8n, Zapier, Albato) or a script posts record envelopes to
 * `POST /v1/source-connections/:id/records` with a brain:write key and
 * nothing polls. Each batch is a `source_sync` job_run of its own
 * (`ranBy: push`), each record a catalogue row (`<type>/<id>`, the
 * record's `updatedAt` as revision — an unchanged revision is not
 * re-ingested), each ingest the same records door every vendor uses,
 * and `gone` ids close their facts by the connection's delete policy.
 * The connection's own `config.mapping` is the mapping; the pack's
 * push entry has no preset (the pusher's field names are its own).
 */
@Injectable()
export class RecordsPushService {
  private readonly logger = new Logger(RecordsPushService.name);

  // eslint-disable-next-line max-params
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly catalogue: SourceItemService,
    private readonly effects: SourceItemEffectsService,
    private readonly gonePolicy: SourceGonePolicyService,
    private readonly jobs: JobRunService,
  ) {}

  async push(
    companyId: string,
    p: { connectionId: string; body: PushRecordsRequest; actor: string },
  ): Promise<PushRecordsResponse> {
    const row = await this.connections.load(companyId, p.connectionId);
    if (row.shape !== 'structure') {
      throw new BadRequestException(
        `connection ${p.connectionId} takes ${row.shape}-shaped items, not records`,
      );
    }
    if (row.status !== 'active') {
      throw new BadRequestException(`connection ${p.connectionId} is ${row.status}`);
    }
    const job = await this.jobs.start({
      jobType: 'source_sync',
      companyId,
      triggeredBy: 'manual',
      triggeredByActor: p.actor,
      initialProgress: { connectionId: p.connectionId, push: true, records: p.body.records.length },
    });
    const out: PushRecordsResponse = {
      runId: job.runId,
      received: p.body.records.length,
      ingested: 0,
      deduplicated: 0,
      failed: 0,
      gone: 0,
      closed: 0,
      errors: [],
    };
    try {
      const view = this.connections.toConnectorView(
        row,
        await this.connections.sourceContext(companyId, row),
      );
      const mapping: RecordMapping = mergeMappings(
        undefined,
        (row.config?.mapping as RecordMapping | undefined) ?? undefined,
      );
      const seenAt = new Date();
      for (const record of p.body.records) {
        const item = describeRecord(record.entityType, record);
        if (p.body.sourceVersion) item.revision = `v:${p.body.sourceVersion}`;
        try {
          const upsert = await this.catalogue.upsertSeen(companyId, {
            connectionId: p.connectionId,
            userId: row.userId ?? null,
            item,
            seenAt,
          });
          if (!upsert.changed) {
            out.deduplicated++;
            continue;
          }
          const r = await this.effects.ingestFetched({
            companyId,
            connection: view,
            row: upsert.row,
            fetched: {
              shape: 'structure',
              record,
              ...(mapping[record.entityType] ? { mapping: mapping[record.entityType] } : {}),
            },
          });
          if (r.status === 'ingested') out.ingested++;
          else if (r.status === 'deduplicated') out.deduplicated++;
          else {
            out.failed++;
            out.errors.push({ externalId: item.externalId, error: r.error ?? r.status });
          }
        } catch (e) {
          out.failed++;
          out.errors.push({ externalId: item.externalId, error: (e as Error).message });
        }
      }
      out.closed = await this.close(companyId, { row, gone: p.body.gone ?? [], out });
      await this.connections.recordSync(companyId, p.connectionId, {
        status: out.failed > 0 && out.ingested === 0 && out.received > 0 ? 'failed' : 'succeeded',
        ...(out.errors[0] ? { error: out.errors[0].error } : {}),
      });
      await this.jobs.finish(job, {
        status: 'succeeded',
        result: { ...out, connectionId: p.connectionId, ranBy: 'push' },
      });
      return out;
    } catch (err) {
      await this.jobs.finish(job, {
        status: 'failed',
        error: { message: (err as Error).message ?? String(err) },
      });
      throw err;
    }
  }

  private async close(
    companyId: string,
    p: { row: SourceConnectionRow; gone: string[]; out: PushRecordsResponse },
  ): Promise<number> {
    const { row, gone, out } = p;
    if (gone.length === 0) return 0;
    const goneAt = new Date();
    const rows = [];
    for (const externalId of gone) {
      const closed = await this.catalogue.markGoneByExternalId(companyId, {
        connectionId: String(row.id),
        externalId: externalId.includes('/') ? externalId : itemIdOf('', externalId),
        at: goneAt,
      });
      if (closed) rows.push(closed);
    }
    out.gone = rows.length;
    const closed = await this.gonePolicy.apply(companyId, row, rows);
    if (closed > 0) this.logger.log(`push to ${String(row.id)}: ${closed} fact(s) closed`);
    return closed;
  }
}
