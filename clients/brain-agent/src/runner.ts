import type { BrainAgentClient } from './protocol.js';
import { redactSecrets } from './redact.js';
import type {
  AgentConnection,
  AgentConnector,
  ConnectorCtx,
  FetchedItem,
  ItemDelta,
  ItemDescriptor,
  SourceEntry,
  SyncSummary,
} from './types.js';

/**
 * One run of one connection, end to end: begin on the brain (it says
 * whether the walk is full and where to resume), walk the source here
 * in batches of deltas (the brain answers with what changed), fetch
 * exactly those items here and post their content, finish with the
 * checkpoint. What leaves the machine is text (or the bytes of a
 * binary-shaped item), redacted first; the catalogue, the doors and the
 * delete policy are the brain's — the agent never decides what is gone,
 * it only reports what it saw.
 */
export interface RunOptions {
  agentId: string;
  full?: boolean;
  redact?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const DEFAULT_BATCH = 500;

export async function runConnection(
  client: BrainAgentClient,
  connector: AgentConnector,
  target: { connection: AgentConnection; source: SourceEntry | null },
  opts: RunOptions,
): Promise<SyncSummary> {
  const log = opts.log ?? (() => undefined);
  const ctx: ConnectorCtx = {
    connection: target.connection,
    source: target.source,
    signal: opts.signal ?? new AbortController().signal,
    log: (line) => log(`[${target.connection.id}] ${line}`),
  };
  const full =
    opts.full === true || connector.walksEverything === true || connector.fullWalk?.(ctx) === true;
  const begun = await client.begin(target.connection.id, { agentId: opts.agentId, ...(full ? { full: true } : {}) });
  const runId = begun.runId;
  const toFetch: string[] = [];
  // The brain names what to fetch by externalId; the connector fetches
  // by the descriptor it enumerated (git is content-addressed: the blob
  // sha IS the revision), so every upsert's descriptor is kept by id.
  const descriptors = new Map<string, ItemDescriptor>();
  let checkpoint: Record<string, unknown> | undefined;
  let batch: ItemDelta[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const out = await client.deltas(target.connection.id, runId, batch);
    toFetch.push(...out.fetch);
    batch = [];
  };
  try {
    for await (const delta of connector.enumerate(ctx, { checkpoint: begun.checkpoint, full: begun.full })) {
      if (delta.type === 'checkpoint') checkpoint = delta.checkpoint;
      if (delta.type === 'upsert') descriptors.set(delta.item.externalId, delta.item);
      batch.push(delta);
      if (batch.length >= (opts.batchSize ?? DEFAULT_BATCH)) await flush();
    }
    await flush();
    if (begun.contentPolicy !== 'manifest') {
      const budget = begun.fetchBudget ?? Number.POSITIVE_INFINITY;
      let sent = 0;
      for (const externalId of toFetch) {
        if (sent >= budget) break;
        if (ctx.signal.aborted) throw new Error('aborted');
        sent++;
        let item: FetchedItem;
        try {
          item = await connector.fetch(ctx, descriptors.get(externalId) ?? { externalId });
        } catch (err) {
          // A poison item is the brain's to count: post nothing, log, go on.
          ctx.log(`fetch ${externalId} failed: ${(err as Error).message}`);
          continue;
        }
        const out = await client.item(target.connection.id, runId, externalId, opts.redact === false ? item : redacted(item, ctx));
        if (out.status === 'failed') ctx.log(`item ${externalId}: ${out.error ?? 'failed'}`);
      }
    }
    const summary = await client.finish(target.connection.id, runId, {
      status: 'succeeded',
      ...(checkpoint ? { checkpoint } : {}),
    });
    return summary;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    try {
      return await client.finish(target.connection.id, runId, { status: 'failed', error: message.slice(0, 2000) });
    } catch (finishErr) {
      throw new Error(`${message} (and finish failed: ${(finishErr as Error).message})`);
    }
  } finally {
    await connector.endRun?.(ctx).catch((e: unknown) => ctx.log(`endRun failed: ${(e as Error).message}`));
  }
}

function redacted(item: FetchedItem, ctx: ConnectorCtx): FetchedItem {
  if (item.shape === 'document') {
    const { text, hits } = redactSecrets(item.text);
    const n = Object.values(hits).reduce((a, b) => a + b, 0);
    if (n > 0) ctx.log(`redacted ${n} secret(s) (${Object.keys(hits).join(', ')})`);
    return { ...item, text };
  }
  if (item.shape === 'conversation') {
    return { ...item, turns: item.turns.map((t) => ({ ...t, text: redactSecrets(t.text).text })) };
  }
  return item;
}

/** Pick the connector for a connection, by the pack entry it runs. */
export function connectorFor(
  registry: readonly AgentConnector[],
  target: { connection: AgentConnection; source: SourceEntry | null },
): AgentConnector {
  const c = target.connection;
  const kind = c.kind === 'native' ? c.connector : c.kind;
  if (c.kind === 'mcp' && target.source?.transport !== 'stdio') {
    throw new Error(`connection ${c.id}: an http MCP source runs on the brain, not the agent`);
  }
  if (c.kind === 'external') throw new Error(`connection ${c.id}: an external source is pushed by its publisher`);
  const found = registry.find((r) => r.kind === kind);
  if (!found) throw new Error(`connection ${c.id}: this agent has no "${kind}" connector`);
  return found;
}
