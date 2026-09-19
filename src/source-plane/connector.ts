import type { EvidenceModality } from '../common/evidence-taxonomy';
import type { PackSourceShape, PackSourceSpec } from '../ai/domain-packs/manifest';
import type { OAuthProviderId } from './oauth/oauth-providers';
import type { EntityMapping } from './records/record-mapping';

/**
 * Connector — the source-plane seam (docs/roadmap/
 * raw-evidence-sources-2026-09.md § 5.3). One runtime, two hosts: the
 * same module runs inside the server (mounted volume, bucket, cloud API,
 * remote MCP) and inside the local agent (folders, stdio MCP). The host
 * owns credentials and raw bytes; the connector never does.
 *
 * Natives are PLATFORM code registered under SOURCE_CONNECTORS (the
 * EVIDENCE_PROCESSOR_ADAPTERS mold — a pack may only NAME a connector
 * kind, never supply one; anti-DSL doctrine). MCP is the only
 * third-party seam, and it is itself one connector ('mcp', W2).
 *
 * Two verbs carry the whole contract:
 *   enumerate — cheap, no bytes: stream item descriptors and `gone`
 *               markers from a checkpoint, and emit the next checkpoint.
 *   fetch     — the content of ONE item, in the SHAPE the pack declared:
 *               the shape decides the ingest door (doctrine 2).
 * `watch`, `principals` and `search` are reserved for W2/W5/W7 and are
 * optional so an implementation may ship without them.
 */

export interface ConnectorConnectionView {
  id: string;
  packId: string;
  sourceId: string;
  kind: string;
  connector: string;
  shape: PackSourceShape;
  host: string;
  /** Connector configuration — never secrets. */
  config: Record<string, unknown>;
  /** Resolved credential, when the host holds one. */
  credential: string | null;
  /** Where it came from: a connected account (bearer), an operator secret (the vendor's own scheme), a pack install secret. */
  credentialSource: 'grant' | 'secret' | 'install' | null;
  contentPolicy: 'manifest' | 'text' | 'bytes';
  /** What happens to an item's facts when it is gone (absent = `close`). */
  deletePolicy?: 'close' | 'retract' | 'keep' | undefined;
  vertical: string;
  recorder: string;
  userId: string | null;
  /** The pack entry this connection instantiates (its declared url /
   *  auth for `mcp`), when the pack still declares it. */
  source?: PackSourceSpec | null | undefined;
  /**
   * What the connected account said about itself at the token endpoint
   * (W4.2c): its own API origin (Salesforce `instance_url`, Pipedrive
   * `api_domain`) and its label. Null for a secret credential.
   */
  grant?: { account: string | null; apiBase: string | null } | null | undefined;
}

export interface ConnectorCtx {
  companyId: string;
  connection: ConnectorConnectionView;
  /** Aborts on lost lease / operator cancel / pod shutdown. */
  signal: AbortSignal;
  log: (line: string) => void;
}

/** What `enumerate` knows about an item without reading it. */
export interface ItemDescriptor {
  /** The source's own stable id (file id, message id, path…). */
  externalId: string;
  originUri?: string | undefined;
  path?: string | undefined;
  title?: string | undefined;
  mediaType?: string | undefined;
  size?: number | undefined;
  /** The source's revision token (etag, revisionId, mtime+size, commit). */
  revision?: string | undefined;
  /** ISO 8601 — the source's own clock, becomes `occurredAt`. */
  modifiedAt?: string | undefined;
  /** ACL snapshot for org connections (G6 consumes it; W0 stores it). */
  acl?: Record<string, unknown> | undefined;
}

export type ItemDelta =
  | { type: 'upsert'; item: ItemDescriptor }
  | { type: 'gone'; externalId: string }
  /** The cursor to resume from next time; the last one emitted wins. */
  | { type: 'checkpoint'; checkpoint: Record<string, unknown> };

export interface EnumerateOptions {
  /** Null = never synced (or a full walk was requested). */
  checkpoint: Record<string, unknown> | null;
  /** True ⇒ the engine expects EVERY live item to be re-emitted so the
   *  ones it does not see can be marked gone. */
  full: boolean;
}

export interface ConversationTurn {
  text: string;
  speaker?: string | undefined;
  role?: string | undefined;
  /** ISO 8601. */
  at?: string | undefined;
  messageId?: string | undefined;
}

/**
 * The record envelope (doctrine: "records are a shape, not a document").
 * A CRM row, a ticket, a table row: entities + attributes + relations
 * with a revision. W0 renders it deterministically and hands it to the
 * document door; the deterministic attribute→predicate candidate path
 * lands with the first structure-shaped native (W4).
 */
export interface RecordEnvelope {
  entityType: string;
  externalId: string;
  name: string;
  attributes: Record<string, string | number | boolean | null>;
  relations?:
    | Array<{
        kind: string;
        targetType: string;
        targetExternalId: string;
        targetName?: string | undefined;
      }>
    | undefined;
  /** ISO 8601. */
  updatedAt?: string | undefined;
}

export type FetchedItem =
  | {
      shape: 'document';
      text: string;
      title?: string | undefined;
      /** ISO 8601; defaults to the descriptor's modifiedAt. */
      occurredAt?: string | undefined;
      /** Free-form ≤ 64 chars; defaults to 'source_document'. */
      kind?: string | undefined;
    }
  | {
      shape: 'binary';
      bytes: Buffer;
      mediaType: string;
      modality: EvidenceModality;
      occurredAt?: string | undefined;
    }
  | {
      shape: 'conversation';
      conversationId: string;
      turns: ConversationTurn[];
    }
  | {
      shape: 'structure';
      record: RecordEnvelope;
      /** How the record's attributes become facts (records/record-mapping.ts); absent = render only. */
      mapping?: EntityMapping | undefined;
    };

export interface Connector {
  /** `^[a-z][a-z0-9_]{1,31}$` — what a pack's `native.connector` names. */
  readonly kind: string;
  /**
   * True for sources with no change feed (a filesystem walk, a bucket
   * listing): every enumerate re-emits every live item, so the engine
   * treats every run as full and marks what it did not see gone.
   */
  readonly walksEverything?: boolean;
  /** Runtime switch (SOURCE_KIND_<KIND>); absent = always on. A kind that
   *  answers false is "not installed" to the engine. */
  enabled?(): boolean;
  /**
   * What an operator has to fill in — the connection `config` an admin
   * surface pre-fills, keys with their example values (never secrets).
   * Static and declarative: the catalogue endpoint publishes it, the
   * connector never sees it again.
   */
  readonly configExample?: Record<string, unknown>;
  /** One line on what `credential` is when the connector takes one. */
  readonly credentialHint?: string;
  /**
   * The connector authenticates through a connected account (W4): the
   * provider it speaks and the scopes a grant must carry. A connection
   * of it names its grant as `credential: 'oauth:<grant id>'`; the
   * engine hands the connector a fresh access token in `credential`.
   */
  readonly oauth?: {
    provider: OAuthProviderId;
    scopes: string[];
    /** True = the vendor also takes a plain secret (an API token) as `credential`. */
    optional?: boolean;
  };
  enumerate(ctx: ConnectorCtx, opts: EnumerateOptions): AsyncIterable<ItemDelta>;
  fetch(ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem>;
  /** Called once a run is over (success or failure) — release a session
   *  the connector kept across enumerate + fetch (an MCP client). */
  endRun?(ctx: ConnectorCtx): Promise<void>;
}

/**
 * Natives that exist on the local agent only — git and db never run in
 * the brain process (the clone, the DSN stay on the machine); the
 * catalogue shows them as `agent`, a server-host connection of them is
 * refused by name. Kept beside the agent's own registry
 * (clients/brain-agent/src/index.ts).
 */
export const AGENT_ONLY_CONNECTORS: ReadonlySet<string> = new Set(['git', 'db']);
/** Natives the agent ships as well as the brain (the machine or the server may walk them). */
export const AGENT_CONNECTORS: ReadonlySet<string> = new Set(['fs', 'git', 'db']);

/** Registry token: an ARRAY of platform connectors, resolved by `kind`. */
export const SOURCE_CONNECTORS = Symbol('SOURCE_CONNECTORS');
export type ConnectorRegistry = readonly Connector[];

export function findConnector(registry: ConnectorRegistry, kind: string): Connector | null {
  const state = connectorState(registry, kind);
  return typeof state === 'string' ? null : state;
}

/** Why a kind is unavailable — the message an operator can act on. */
export function connectorState(
  registry: ConnectorRegistry,
  kind: string,
): Connector | 'missing' | 'disabled' {
  const found = registry.find((c) => c.kind === kind);
  if (!found) return 'missing';
  return found.enabled === undefined || found.enabled() ? found : 'disabled';
}

export function connectorUnavailableMessage(kind: string, state: 'missing' | 'disabled'): string {
  return state === 'missing'
    ? `no installed connector "${kind}"`
    : `connector "${kind}" is installed but switched off (SOURCE_KIND_${kind.toUpperCase()})`;
}
