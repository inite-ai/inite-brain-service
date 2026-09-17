/**
 * The agent's view of the connector seam — the brain's
 * src/source-plane/connector.ts, seen from the other host. **Duplicate**
 * of the wire shapes in src/contracts/source-plane/source-plane.schema.ts
 * (the agent package is standalone, the brain-sdk precedent); the brain
 * validates every byte it receives, so a drift here is a 400, never a
 * silent write.
 */

export interface ItemDescriptor {
  externalId: string;
  originUri?: string;
  path?: string;
  title?: string;
  mediaType?: string;
  size?: number;
  revision?: string;
  modifiedAt?: string;
}

export type ItemDelta =
  | { type: 'upsert'; item: ItemDescriptor }
  | { type: 'gone'; externalId: string }
  | { type: 'checkpoint'; checkpoint: Record<string, unknown> };

export type Modality = 'image' | 'audio' | 'video' | 'document' | 'sensor';

/** The wire form: binary rides as base64 — JSON carries no bytes. */
export type FetchedItem =
  | { shape: 'document'; text: string; title?: string; occurredAt?: string; kind?: string }
  | { shape: 'binary'; bytesBase64: string; mediaType: string; modality: Modality; occurredAt?: string }
  | {
      shape: 'conversation';
      conversationId: string;
      turns: Array<{ text: string; speaker?: string; role?: string; at?: string; messageId?: string }>;
    }
  | {
      shape: 'structure';
      record: {
        entityType: string;
        externalId: string;
        name: string;
        attributes: Record<string, string | number | boolean | null>;
        relations?: Array<{ kind: string; targetType: string; targetExternalId: string; targetName?: string }>;
        updatedAt?: string;
      };
    };

/** A connection as the brain lists it to this agent (the fields the agent reads). */
export interface AgentConnection {
  id: string;
  packId: string;
  sourceId: string;
  kind: 'mcp' | 'native' | 'external';
  connector: string;
  shape: 'document' | 'conversation' | 'binary' | 'structure';
  host: string;
  label: string | null;
  config: Record<string, unknown>;
  contentPolicy: 'manifest' | 'text' | 'bytes';
  schedule: string;
  status: string;
}

/** The pack's `sources[]` entry the connection instantiates. */
export interface SourceEntry {
  id: string;
  kind: 'mcp' | 'native' | 'external';
  shape: string;
  transport?: 'http' | 'stdio';
  command?: string;
  args?: string[];
  connector?: string;
  url?: string;
  auth?: string;
}

export interface ConnectorCtx {
  connection: AgentConnection;
  source: SourceEntry | null;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface EnumerateOptions {
  checkpoint: Record<string, unknown> | null;
  full: boolean;
}

/** One connector, the agent side: cheap enumerate, one fetch per item. */
export interface AgentConnector {
  readonly kind: string;
  /** No change feed: every enumerate re-emits every live item, so every
   *  run is a full walk and the brain marks what it did not see gone. */
  readonly walksEverything?: boolean;
  enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta>;
  fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem>;
  endRun?(ctx: ConnectorCtx): Promise<void>;
}

export interface SyncSummary {
  connectionId: string;
  mode: 'full' | 'incremental';
  status: 'succeeded' | 'failed' | 'skipped';
  skipped?: string;
  seen: number;
  new: number;
  changed: number;
  unchanged: number;
  gone: number;
  fetched: number;
  ingested: number;
  deduplicated: number;
  failed: number;
  closed: number;
  durationMs: number;
  error?: string;
}
