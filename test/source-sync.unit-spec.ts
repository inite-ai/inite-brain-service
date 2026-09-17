/**
 * SourceSyncService — the engine over an in-memory connector and
 * in-memory catalogue / connection doubles:
 *  - a full walk catalogues every item and fetches each once;
 *  - a second run over an unchanged source: 0 fetched, 0 ingested;
 *  - a moved revision is fetched again; an untouched one is not;
 *  - an explicit `gone` (incremental) and an unseen item (full walk)
 *    both close, and the delete policy runs over them;
 *  - `manifest` policy walks without fetching; fetchBudget bounds fetches;
 *  - a poison item is counted failed, the run still succeeds;
 *  - flag off / paused / agent host / unknown connector are named skips
 *    or a failed run — never a throw;
 *  - the checkpoint the connector emits is what the next run resumes from.
 */
import type { SourceSyncSummary } from '../src/contracts/source-plane/source-plane.schema';
import type {
  Connector,
  ConnectorCtx,
  EnumerateOptions,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
} from '../src/source-plane/connector';
import type {
  SourceConnectionRow,
  SourceConnectionService,
} from '../src/source-plane/source-connection.service';
import type { SourceItemEffectsService } from '../src/source-plane/source-item-effects.service';
import type { SourceItemRow, SourceItemService } from '../src/source-plane/source-item.service';
import { SourceSyncService } from '../src/source-plane/source-sync.service';

/** A source with a mutable set of items and an explicit-gone queue. */
class MemorySource implements Connector {
  readonly kind = 'memory';
  items = new Map<string, ItemDescriptor>();
  goneQueue: string[] = [];
  fetches: string[] = [];
  poison = new Set<string>();
  emitCheckpoint: Record<string, unknown> | null = null;
  lastEnumerate: EnumerateOptions | null = null;

  connector(): Connector {
    return this;
  }

  async *enumerate(_ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    this.lastEnumerate = opts;
    for (const item of this.items.values()) yield { type: 'upsert', item };
    for (const externalId of this.goneQueue.splice(0)) yield { type: 'gone', externalId };
    if (this.emitCheckpoint) yield { type: 'checkpoint', checkpoint: this.emitCheckpoint };
  }

  async fetch(_ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    this.fetches.push(item.externalId);
    if (this.poison.has(item.externalId)) throw new Error(`cannot read ${item.externalId}`);
    return { shape: 'document', text: `content of ${item.externalId} @ ${item.revision}` };
  }
}

function connectionRow(over: Partial<SourceConnectionRow> = {}): SourceConnectionRow {
  return {
    id: 'source_connection:c1',
    packId: 'wiki_pack',
    sourceId: 'wiki',
    kind: 'native',
    connector: 'memory',
    shape: 'document',
    host: 'server',
    config: {},
    mode: 'synced',
    schedule: 'manual',
    contentPolicy: 'text',
    deletePolicy: 'close',
    status: 'active',
    checkpoint: null,
    vertical: 'wiki',
    recorder: 'srcconn_c1',
    sourceKey: 'wiki:srcconn_c1',
    ...over,
  };
}

/** In-memory catalogue with the real service's semantics. */
class MemoryCatalogue {
  rows = new Map<string, SourceItemRow>();
  private seq = 0;

  async upsertSeen(
    _c: string,
    p: { connectionId: string; userId: string | null; item: ItemDescriptor; seenAt: Date },
  ) {
    const existing = this.rows.get(p.item.externalId);
    if (!existing) {
      const row: SourceItemRow = {
        id: `source_item:i${++this.seq}`,
        connectionId: p.connectionId,
        externalId: p.item.externalId,
        revision: p.item.revision ?? null,
        state: 'seen',
        firstSeenAt: p.seenAt,
        lastSeenAt: p.seenAt,
      };
      this.rows.set(p.item.externalId, row);
      return { row, isNew: true, changed: true };
    }
    const wasGone = existing.state === 'gone';
    const revisionMoved =
      p.item.revision !== undefined && p.item.revision !== (existing.fetchedRevision ?? null);
    const neverFetched = existing.fetchedRevision == null && existing.state === 'seen';
    existing.revision = p.item.revision ?? null;
    existing.lastSeenAt = p.seenAt;
    if (wasGone) {
      existing.state = 'seen';
      existing.goneAt = undefined;
    }
    return { row: existing, isNew: false, changed: wasGone || revisionMoved || neverFetched };
  }

  async markIndexed(
    _c: string,
    p: { itemId: string; revision: string | null; documentId?: string },
  ) {
    const row = [...this.rows.values()].find((r) => r.id === p.itemId)!;
    row.state = 'indexed';
    row.fetchedRevision = p.revision;
    if (p.documentId !== undefined) row.documentId = p.documentId;
    row.lastError = null;
  }

  async markFailed(_c: string, itemId: string, error: string) {
    const row = [...this.rows.values()].find((r) => r.id === itemId)!;
    row.lastError = error;
  }

  async markGoneByExternalId(_c: string, p: { externalId: string; at: Date }) {
    const row = this.rows.get(p.externalId);
    if (!row || row.state === 'gone') return null;
    row.state = 'gone';
    row.goneAt = p.at;
    return row;
  }

  async markUnseenGone(_c: string, p: { runStartedAt: Date; goneAt: Date }) {
    const out: SourceItemRow[] = [];
    for (const row of this.rows.values()) {
      if (row.state !== 'gone' && (row.lastSeenAt as Date) < p.runStartedAt) {
        row.state = 'gone';
        row.goneAt = p.goneAt;
        out.push(row);
      }
    }
    return out;
  }
}

function harness(
  opts: { row?: Partial<SourceConnectionRow>; source?: MemorySource; registered?: boolean } = {},
) {
  const source = opts.source ?? new MemorySource();
  const row = connectionRow(opts.row);
  const catalogue = new MemoryCatalogue();
  const recorded: Array<Record<string, unknown>> = [];
  const goneApplied: SourceItemRow[][] = [];
  let ingestedCount = 0;
  const connections = {
    load: async () => row,
    resolveConnector: () => (opts.registered === false ? null : source.connector()),
    connectorUnavailable: () => 'no installed connector "memory"',
    sourceContext: async () => ({ source: null, installSecret: null }),
    toConnectorView: () => ({
      id: String(row.id),
      packId: row.packId,
      sourceId: row.sourceId,
      kind: row.kind,
      connector: row.connector,
      shape: row.shape,
      host: row.host,
      config: {},
      credential: null,
      contentPolicy: row.contentPolicy,
      vertical: row.vertical,
      recorder: row.recorder,
      userId: null,
    }),
    recordSync: async (_c: string, _id: string, p: Record<string, unknown>) => {
      recorded.push(p);
      if (p.checkpoint !== undefined) row.checkpoint = p.checkpoint as Record<string, unknown>;
    },
    due: async () => [],
  } as unknown as SourceConnectionService;
  const effects = {
    fetchAndIngest: async (p: { connector: Connector; ctx: ConnectorCtx; row: SourceItemRow }) => {
      try {
        await p.connector.fetch(p.ctx, {
          externalId: p.row.externalId,
          revision: p.row.revision ?? undefined,
        });
        await catalogue.markIndexed('co', {
          itemId: String(p.row.id),
          revision: p.row.revision ?? null,
          documentId: `source_document:${p.row.externalId}`,
        });
        ingestedCount++;
        return { status: 'ingested' as const };
      } catch (e) {
        await catalogue.markFailed('co', String(p.row.id), (e as Error).message);
        return { status: 'failed' as const, error: (e as Error).message };
      }
    },
    applyGone: async (_c: string, _row: SourceConnectionRow, rows: SourceItemRow[]) => {
      goneApplied.push(rows);
      return rows.filter((r) => r.documentId).length;
    },
  } as unknown as SourceItemEffectsService;
  const svc = new SourceSyncService(
    connections,
    catalogue as unknown as SourceItemService,
    effects,
  );
  return {
    svc,
    source,
    row,
    catalogue,
    recorded,
    goneApplied,
    ingested: () => ingestedCount,
    // A full walk marks gone what was last seen BEFORE the run started;
    // two runs inside one millisecond would tie on the clock, so runs
    // in this harness are separated by a tick (a real run takes longer).
    run: async (o: { full?: boolean } = {}) => {
      await new Promise((r) => setTimeout(r, 2));
      return svc.sync('co', String(row.id), o);
    },
  };
}

const counts = (s: SourceSyncSummary) => ({
  status: s.status,
  seen: s.seen,
  new: s.new,
  changed: s.changed,
  unchanged: s.unchanged,
  gone: s.gone,
  fetched: s.fetched,
  ingested: s.ingested,
  failed: s.failed,
  closed: s.closed,
});

describe('SourceSyncService', () => {
  const saved = process.env.SOURCE_PLANE_ENABLED;
  beforeEach(() => {
    process.env.SOURCE_PLANE_ENABLED = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SOURCE_PLANE_ENABLED;
    else process.env.SOURCE_PLANE_ENABLED = saved;
  });

  it('full walk: catalogues and fetches every item once; a rerun over an unchanged source fetches nothing', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    h.source.items.set('b', { externalId: 'b', revision: 'r1' });
    const first = await h.run();
    expect(first.mode).toBe('full');
    expect(counts(first)).toEqual({
      status: 'succeeded',
      seen: 2,
      new: 2,
      changed: 0,
      unchanged: 0,
      gone: 0,
      fetched: 2,
      ingested: 2,
      failed: 0,
      closed: 0,
    });
    expect(h.source.fetches).toEqual(['a', 'b']);
    expect([...h.catalogue.rows.values()].map((r) => r.state)).toEqual(['indexed', 'indexed']);

    const second = await h.run();
    expect(second.mode).toBe('incremental');
    expect(counts(second)).toEqual({
      status: 'succeeded',
      seen: 2,
      new: 0,
      changed: 0,
      unchanged: 2,
      gone: 0,
      fetched: 0,
      ingested: 0,
      failed: 0,
      closed: 0,
    });
    expect(h.source.fetches).toHaveLength(2);
  });

  it('a moved revision is fetched again; the others are not', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    h.source.items.set('b', { externalId: 'b', revision: 'r1' });
    await h.run();
    h.source.items.set('b', { externalId: 'b', revision: 'r2' });
    const s = await h.run();
    expect(counts(s)).toMatchObject({ changed: 1, unchanged: 1, fetched: 1, ingested: 1 });
    expect(h.source.fetches.slice(2)).toEqual(['b']);
    expect(h.catalogue.rows.get('b')!.fetchedRevision).toBe('r2');
  });

  it('an explicit gone (incremental) closes the item and runs the delete policy', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    await h.run();
    h.source.items.delete('a');
    h.source.goneQueue.push('a');
    const s = await h.run();
    expect(counts(s)).toMatchObject({ gone: 1, closed: 1, fetched: 0 });
    expect(h.catalogue.rows.get('a')!.state).toBe('gone');
    expect(h.goneApplied[1]!.map((r) => r.externalId)).toEqual(['a']);
  });

  it('a full walk marks what it did not see gone; a resurrected item is fetched again', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    h.source.items.set('b', { externalId: 'b', revision: 'r1' });
    await h.run();
    h.source.items.delete('b');
    const s = await h.run({ full: true });
    expect(counts(s)).toMatchObject({ seen: 1, unchanged: 1, gone: 1, closed: 1 });
    expect(h.catalogue.rows.get('b')!.state).toBe('gone');
    h.source.items.set('b', { externalId: 'b', revision: 'r1' });
    const back = await h.run();
    expect(counts(back)).toMatchObject({ changed: 1, fetched: 1 });
    expect(h.catalogue.rows.get('b')!.state).toBe('indexed');
  });

  it('manifest policy walks without fetching; fetchBudget bounds fetches', async () => {
    const m = harness({ row: { contentPolicy: 'manifest' } });
    m.source.items.set('a', { externalId: 'a', revision: 'r1' });
    expect(counts(await m.run())).toMatchObject({ seen: 1, new: 1, fetched: 0 });
    expect(m.catalogue.rows.get('a')!.state).toBe('seen');

    const b = harness({ row: { fetchBudget: 2 } });
    for (const id of ['a', 'b', 'c']) b.source.items.set(id, { externalId: id, revision: 'r1' });
    expect(counts(await b.run())).toMatchObject({ new: 3, fetched: 2, ingested: 2 });
    // The unfetched item stays changed and is picked up next run.
    expect(counts(await b.run())).toMatchObject({ changed: 1, fetched: 1 });
  });

  it('a poison item is counted failed; the run still succeeds and the row keeps the error', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    h.source.items.set('bad', { externalId: 'bad', revision: 'r1' });
    h.source.poison.add('bad');
    const s = await h.run();
    expect(counts(s)).toMatchObject({ status: 'succeeded', fetched: 2, ingested: 1, failed: 1 });
    expect(h.catalogue.rows.get('bad')!.lastError).toContain('cannot read bad');
  });

  it('the emitted checkpoint is stored and resumed from', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    h.source.emitCheckpoint = { cursor: 'page-2' };
    await h.run();
    expect(h.row.checkpoint).toEqual({ cursor: 'page-2' });
    await h.run();
    expect(h.source.lastEnumerate).toEqual({ checkpoint: { cursor: 'page-2' }, full: false });
    await h.run({ full: true });
    expect(h.source.lastEnumerate).toEqual({ checkpoint: null, full: true });
  });

  const skips: Array<[string, Partial<SourceConnectionRow>, () => void]> = [
    ['flag_off', {}, () => void delete process.env.SOURCE_PLANE_ENABLED],
    ['status_paused', { status: 'paused' }, () => undefined],
    ['agent_host', { host: 'agent:laptop' }, () => undefined],
  ];
  it.each(skips)('names the skip: %s', async (skipped, row, arrange) => {
    arrange();
    const h = harness({ row });
    h.source.items.set('a', { externalId: 'a' });
    const s = await h.run();
    expect(s).toMatchObject({ status: 'skipped', skipped, seen: 0 });
    expect(h.source.fetches).toHaveLength(0);
  });

  it('no installed connector ⇒ a failed run recorded on the connection, never a throw', async () => {
    const h = harness({ registered: false });
    const s = await h.run();
    expect(s.status).toBe('failed');
    expect(s.error).toContain('no installed connector');
    expect(h.recorded[0]).toMatchObject({ status: 'failed' });
  });

  it('a connector that throws mid-walk fails the run and keeps what it catalogued', async () => {
    const h = harness();
    h.source.items.set('a', { externalId: 'a', revision: 'r1' });
    const broken = h.source.connector();
    broken.enumerate = async function* () {
      yield { type: 'upsert', item: { externalId: 'a', revision: 'r1' } } as ItemDelta;
      throw new Error('token expired');
    };
    (
      h.svc as unknown as { connections: { resolveConnector: () => Connector } }
    ).connections.resolveConnector = () => broken;
    const s = await h.run();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('token expired');
    expect(h.catalogue.rows.get('a')).toBeDefined();
    expect(h.recorded.at(-1)).toMatchObject({ status: 'failed', error: 'token expired' });
  });
});
