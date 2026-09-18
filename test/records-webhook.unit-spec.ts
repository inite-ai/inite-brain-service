/**
 * RecordsWebhookService without a queue (W4.2c): the receipt path with
 * stubs — 404 for the unaddressed / switched-off / non-records cases,
 * 401 for a rejected call, events filtered to the entities the
 * connection syncs, deduplicated (a deletion wins), capped, and applied
 * inline through the connector's `fetchRecord` and the effects seam
 * with one job_run receipt.
 */
import { randomBytes } from 'node:crypto';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConnectorCtx, RecordEnvelope } from '../src/source-plane/connector';
import { encryptSecret } from '../src/source-plane/credential-cipher';
import {
  RecordsConnector,
  type EntitySpec,
  type ListPage,
} from '../src/source-plane/records/records-connector';
import {
  RecordsWebhookService,
  WEBHOOK_MAX_EVENTS,
} from '../src/source-plane/records/records-webhook.service';
import { signAddress } from '../src/source-plane/records/webhook-address';
import { signedWebhook, type WebhookRequest } from '../src/source-plane/records/webhook-schemes';

class StubConnector extends RecordsConnector {
  readonly kind = 'stub_records';
  override readonly webhook = signedWebhook;
  readonly entities: EntitySpec[] = [
    { type: 'deal', label: 'Deals', defaultOn: true, fields: [] },
    { type: 'person', label: 'People', defaultOn: false, fields: [] },
  ];
  readonly preset = { deal: { fields: { stage: 'deal_stage' } } };
  rows = new Map<string, RecordEnvelope>();
  gets: string[] = [];
  async list(): Promise<ListPage> {
    return { records: [], next: null };
  }
  override async get(
    _ctx: ConnectorCtx,
    entity: string,
    id: string,
  ): Promise<RecordEnvelope | null> {
    this.gets.push(`${entity}/${id}`);
    return this.rows.get(`${entity}/${id}`) ?? null;
  }
}

describe('RecordsWebhookService (inline, no queue)', () => {
  const saved = {
    key: process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY,
    flag: process.env.SOURCE_WEBHOOKS,
  };
  beforeAll(() => {
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.SOURCE_WEBHOOKS = '1';
  });
  afterAll(() => {
    if (saved.key === undefined) delete process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = saved.key;
    if (saved.flag === undefined) delete process.env.SOURCE_WEBHOOKS;
    else process.env.SOURCE_WEBHOOKS = saved.flag;
  });

  const secret = 'stub-secret-stub-secret';
  const build = (opts: { secret?: string | null; status?: string; shape?: string } = {}) => {
    const connector = new StubConnector();
    connector.rows.set('deal/41', {
      entityType: 'deal',
      externalId: '41',
      name: 'Ledger migration',
      attributes: { stage: 'Negotiation' },
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    const row = {
      id: 'source_connection:stub1',
      packId: 'crm_memory',
      sourceId: 'stub',
      kind: 'native',
      connector: 'stub_records',
      shape: opts.shape ?? 'structure',
      host: 'server',
      config: { entities: ['deal'] },
      credential: null,
      mode: 'synced',
      schedule: 'manual',
      contentPolicy: 'text',
      deletePolicy: 'close',
      status: opts.status ?? 'active',
      vertical: 'crm',
      recorder: 'r',
      sourceKey: 'crm:r',
      webhookSecret: opts.secret === null ? null : encryptSecret(opts.secret ?? secret),
    };
    const seen = new Map<string, string>();
    const calls = {
      upserts: [] as string[],
      ingests: [] as string[],
      gone: [] as string[],
      jobs: [] as string[],
      touched: 0,
    };
    const connections = {
      load: async (_c: string, id: string) => {
        if (id !== row.id) throw new NotFoundException();
        return row;
      },
      webhookSecretOf: (r: typeof row) => (r.webhookSecret ? secret : null),
      resolveConnector: () => connector,
      connectorUnavailable: () => 'unavailable',
      touchWebhook: async () => {
        calls.touched++;
      },
      setWebhookSecret: async () => undefined,
      credentialFor: async () => null,
      sourceContext: async () => ({ source: null, installSecret: null }),
      grantHints: async () => null,
      toConnectorView: (r: typeof row) => ({
        ...r,
        config: r.config,
        credential: null,
        credentialSource: null,
        userId: null,
      }),
    };
    const catalogue = {
      upsertSeen: async (_c: string, p: { item: { externalId: string; revision?: string } }) => {
        calls.upserts.push(p.item.externalId);
        const changed = seen.get(p.item.externalId) !== p.item.revision;
        seen.set(p.item.externalId, p.item.revision ?? '');
        return {
          changed,
          isNew: changed,
          row: {
            id: `source_item:${p.item.externalId}`,
            externalId: p.item.externalId,
            state: 'seen',
          },
        };
      },
      markGoneByExternalId: async (_c: string, p: { externalId: string }) => {
        if (!seen.has(p.externalId)) return null;
        seen.delete(p.externalId);
        calls.gone.push(p.externalId);
        return { id: `source_item:${p.externalId}`, externalId: p.externalId, state: 'gone' };
      },
    };
    const effects = {
      ingestFetched: async (p: { row: { externalId: string } }) => {
        calls.ingests.push(p.row.externalId);
        return { status: 'ingested' as const };
      },
      applyGone: async (_c: string, _r: unknown, rows: unknown[]) => rows.length * 2,
    };
    const jobs = {
      start: async (p: { triggeredByActor?: string }) => {
        calls.jobs.push(`start:${p.triggeredByActor}`);
        return { runId: 'run-1' };
      },
      finish: async (_j: unknown, o: { status: string }) => {
        calls.jobs.push(`finish:${o.status}`);
      },
    };
    const svc = new RecordsWebhookService(
      connections as never,
      catalogue as never,
      effects as never,
      jobs as never,
    );
    return { svc, connector, calls, row };
  };
  const address = () => signAddress('co_stub', 'stub1');
  const req = (body: unknown, token = secret): WebhookRequest => ({
    method: 'POST',
    url: 'https://brain.example.test/x',
    headers: {},
    rawBody: Buffer.from(JSON.stringify(body)),
    body,
    query: { token },
  });

  it('applies inline: fetches the named deal, ingests it, deduplicates a repeat, closes a deletion; one job_run receipt each', async () => {
    const { svc, connector, calls } = build();
    const first = await svc.receive(
      address(),
      req({
        events: [
          { entity: 'deal', id: 41 },
          { entity: 'deal', id: '41' },
          { entity: 'ticket', id: 7 },
        ],
      }),
    );
    expect(first).toMatchObject({ accepted: 1, ignored: 1, runId: null });
    expect(first.summary).toMatchObject({
      received: 1,
      fetched: 1,
      ingested: 1,
      deduplicated: 0,
      gone: 0,
      failed: 0,
    });
    expect(connector.gets).toEqual(['deal/41']);
    expect(calls.jobs).toEqual(['start:webhook:signed', 'finish:succeeded']);
    expect(calls.touched).toBe(1);
    const again = await svc.receive(address(), req({ entity: 'deal', id: 41 }));
    expect(again.summary).toMatchObject({ fetched: 1, deduplicated: 1, ingested: 0 });
    const gone = await svc.receive(
      address(),
      req({
        events: [
          { entity: 'deal', id: 41 },
          { entity: 'deal', id: 41, deleted: true },
        ],
      }),
    );
    expect(gone).toMatchObject({ accepted: 1 });
    expect(gone.summary).toMatchObject({ fetched: 0, gone: 1, closed: 2 });
    expect(calls.gone).toEqual(['deal/41']);
    // A record the vendor no longer has is gone too, and a fetch that throws is a named failure.
    const missing = await svc.receive(address(), req({ entity: 'deal', id: 99 }));
    expect(missing.summary).toMatchObject({ fetched: 1, gone: 0, failed: 0 });
    connector.get = async () => {
      throw new Error('vendor down');
    };
    const failed = await svc.receive(address(), req({ entity: 'deal', id: 41 }));
    expect(failed.summary).toMatchObject({
      failed: 1,
      errors: [{ externalId: 'deal/41', error: 'vendor down' }],
    });
  });

  it('caps a call at WEBHOOK_MAX_EVENTS distinct records and ignores the rest', async () => {
    const { svc } = build();
    const events = Array.from({ length: WEBHOOK_MAX_EVENTS + 20 }, (_, i) => ({
      entity: 'deal',
      id: i,
    }));
    const r = await svc.receive(address(), req({ events }));
    expect(r.accepted).toBe(WEBHOOK_MAX_EVENTS);
    expect(r.ignored).toBe(20);
  });

  it('answers 404 for a bad address, a switched-off webhook, a paused connection, a non-records connector; 401 for a rejected call; 404 without the flag', async () => {
    await expect(build().svc.receive('nope', req({}))).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build().svc.receive(signAddress('co_stub', 'other'), req({})),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(build({ secret: null }).svc.receive(address(), req({}))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      build({ status: 'paused' }).svc.receive(address(), req({})),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build().svc.receive(address(), req({ entity: 'deal', id: 1 }, 'wrong')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const empty = await build().svc.receive(address(), req({ events: [] }));
    expect(empty).toEqual({ accepted: 0, ignored: 0, runId: null });
    process.env.SOURCE_WEBHOOKS = '0';
    await expect(
      build().svc.receive(address(), req({ entity: 'deal', id: 1 })),
    ).rejects.toBeInstanceOf(NotFoundException);
    process.env.SOURCE_WEBHOOKS = '1';
  });

  it('setup: a generated secret, the signed address, the token in the URL for a tokened scheme; refuses a paused-shape connection', async () => {
    const { svc } = build();
    const out = await svc.setup('co_stub', {
      connectionId: 'source_connection:stub1',
      baseUrl: 'https://brain.example.test/',
    });
    expect(out.scheme).toBe('signed');
    expect(out.secret.length).toBeGreaterThanOrEqual(16);
    expect(out.url).toBe(
      `https://brain.example.test/v1/source-connections/webhook/${address()}?token=${encodeURIComponent(out.secret)}`,
    );
    expect(out.notes.some((n) => n.includes(out.url))).toBe(true);
    const own = await svc.setup('co_stub', {
      connectionId: 'source_connection:stub1',
      baseUrl: 'https://brain.example.test',
      secret: 'operator-chosen-secret',
    });
    expect(own.secret).toBe('operator-chosen-secret');
    await expect(
      build({ shape: 'document' }).svc.setup('co_stub', {
        connectionId: 'source_connection:stub1',
        baseUrl: 'https://b',
      }),
    ).rejects.toThrow(/cannot take a webhook/);
  });
});
