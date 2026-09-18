/**
 * McpConnector against a real in-process MCP server (the SDK's McpServer
 * over Streamable HTTP, stateless mode — the brain's own controller's
 * shape): resources/list paged as the catalogue, resources/read as the
 * fetch, lastModified as the revision, blobs to the binary shape, the
 * egress fence and the operator-named url, and the session that lives
 * exactly one run.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { PackMcpHttpSourceSpec } from '../src/ai/domain-packs/manifest';
import type { ConnectorCtx, ItemDelta } from '../src/source-plane/connector';
import { McpConnector, admitResource } from '../src/source-plane/connectors/mcp.connector';

let server: Server;
let base = '';
const seenAuth: string[] = [];

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: 'wiki-test', version: '0.0.1' });
  mcp.registerResource(
    'intro',
    'wiki://pages/intro',
    {
      title: 'Intro page',
      mimeType: 'text/markdown',
      annotations: { lastModified: '2026-03-01T10:00:00Z' },
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/markdown', text: '# Intro\nAcme was founded in 2019.' },
      ],
    }),
  );
  mcp.registerResource(
    'nohints',
    'wiki://pages/nohints',
    { mimeType: 'text/plain' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'no hints here' }],
    }),
  );
  mcp.registerResource(
    'plan',
    'wiki://files/plan.pdf',
    {
      title: 'Plan',
      mimeType: 'application/pdf',
      annotations: { lastModified: '2026-03-02T00:00:00Z' },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/pdf',
          blob: Buffer.from('%PDF-1.4 fake').toString('base64'),
        },
      ],
    }),
  );
  mcp.registerResource(
    'other',
    'crm://accounts/1',
    { mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"a":1}' }],
    }),
  );
  return mcp;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seenAuth.push(String(req.headers.authorization ?? ''));
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body: unknown = raw ? JSON.parse(raw) : undefined;
  const mcp = buildMcp();
  const transport = new StreamableHTTPServerTransport({});
  res.on('close', () => {
    transport.close().catch(() => undefined);
    mcp.close().catch(() => undefined);
  });
  await mcp.connect(transport as Transport);
  await transport.handleRequest(req, res, body);
}

const ENTRY: PackMcpHttpSourceSpec = {
  id: 'mcp_resources',
  kind: 'mcp',
  transport: 'http',
  auth: 'none',
  shape: 'document',
};

function ctx(
  config: Record<string, unknown>,
  over: {
    shape?: 'document' | 'binary';
    credential?: string;
    source?: PackMcpHttpSourceSpec | null;
  } = {},
): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:m1',
      packId: 'web_memory',
      sourceId: 'mcp_resources',
      kind: 'mcp',
      connector: 'mcp',
      shape: over.shape ?? 'document',
      host: 'server',
      config: { url: `${base}/mcp`, allowPrivate: true, ...config },
      credential: over.credential ?? null,
      credentialSource: null,
      contentPolicy: 'text',
      vertical: 'web',
      recorder: 'srcconn_m1',
      userId: null,
      source: over.source === undefined ? ENTRY : over.source,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function walk(c: McpConnector, x: ConnectorCtx): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of c.enumerate(x, { checkpoint: null, full: true })) out.push(d);
  return out;
}
const upserts = (deltas: ItemDelta[]) =>
  deltas.filter((d): d is Extract<ItemDelta, { type: 'upsert' }> => d.type === 'upsert');

describe('McpConnector', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      handle(req, res).catch((e: unknown) => {
        res.statusCode = 500;
        res.end(String((e as Error).message));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const k of ['SOURCE_EGRESS_ALLOW_PRIVATE', 'SOURCE_KIND_MCP']) saved[k] = process.env[k];
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    process.env.SOURCE_KIND_MCP = '1';
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seenAuth.length = 0;
  });

  it('lists resources as the catalogue: lastModified is the revision, a missing one a time bucket', async () => {
    const c = new McpConnector();
    const x = ctx({});
    const deltas = await walk(c, x);
    const items = upserts(deltas).map((d) => d.item);
    expect(items.map((i) => i.externalId).sort()).toEqual([
      'crm://accounts/1',
      'wiki://files/plan.pdf',
      'wiki://pages/intro',
      'wiki://pages/nohints',
    ]);
    const intro = items.find((i) => i.externalId === 'wiki://pages/intro')!;
    expect(intro).toMatchObject({
      originUri: 'wiki://pages/intro',
      title: 'Intro page',
      mediaType: 'text/markdown',
      revision: 'lm:2026-03-01T10:00:00Z',
      modifiedAt: '2026-03-01T10:00:00Z',
    });
    const nohints = items.find((i) => i.externalId === 'wiki://pages/nohints')!;
    expect(nohints.revision).toMatch(/^t:\d+$/);
    expect(nohints.title).toBe('nohints');
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { listed: 4, kept: 4 } });
    await c.endRun(x);
  });

  it('uriPrefixes / mimeTypes narrow the catalogue; maxResources truncates it by name', async () => {
    const c = new McpConnector();
    const narrowed = ctx({ uriPrefixes: ['wiki://'], mimeTypes: ['text/'] });
    expect(
      upserts(await walk(c, narrowed))
        .map((d) => d.item.externalId)
        .sort(),
    ).toEqual(['wiki://pages/intro', 'wiki://pages/nohints']);
    await c.endRun(narrowed);
    const capped = ctx({ maxResources: 2 });
    const deltas = await walk(c, capped);
    expect(upserts(deltas)).toHaveLength(2);
    expect(deltas.at(-1)).toMatchObject({
      type: 'checkpoint',
      checkpoint: { kept: 2, truncated: true },
    });
    await c.endRun(capped);
    expect(admitResource({ mimeTypes: ['text/'] }, 'x', undefined)).toBe(false);
    expect(admitResource({}, 'x', undefined)).toBe(true);
  });

  it('reads a text resource as a document and a blob as binary — the shape decides', async () => {
    const c = new McpConnector();
    const doc = ctx({});
    const intro = await c.fetch(doc, {
      externalId: 'wiki://pages/intro',
      title: 'Intro page',
      modifiedAt: '2026-03-01T10:00:00Z',
    });
    expect(intro).toEqual({
      shape: 'document',
      text: '# Intro\nAcme was founded in 2019.',
      title: 'Intro page',
      occurredAt: '2026-03-01T10:00:00Z',
      kind: 'mcp_resource',
    });
    await expect(c.fetch(doc, { externalId: 'wiki://files/plan.pdf' })).rejects.toThrow(
      'needs a binary-shaped entry',
    );
    await c.endRun(doc);

    const bin = ctx({}, { shape: 'binary' });
    const pdf = await c.fetch(bin, {
      externalId: 'wiki://files/plan.pdf',
      mediaType: 'application/pdf',
    });
    expect(pdf).toMatchObject({
      shape: 'binary',
      mediaType: 'application/pdf',
      modality: 'document',
    });
    expect((pdf as { bytes: Buffer }).bytes.toString()).toBe('%PDF-1.4 fake');
    await expect(c.fetch(bin, { externalId: 'wiki://pages/intro' })).rejects.toThrow(
      'needs a document-shaped entry',
    );
    await c.endRun(bin);
  });

  it('one session per run: the client is reused across enumerate + fetch and closed by endRun', async () => {
    const c = new McpConnector();
    const x = ctx({}, { credential: 'tok-123' });
    await walk(c, x);
    await c.fetch(x, { externalId: 'wiki://pages/nohints' });
    // Every request carried the bearer; the initialize handshake ran once.
    expect(seenAuth.every((a) => a === 'Bearer tok-123')).toBe(true);
    const sessions = (c as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.size).toBe(1);
    await c.endRun(x);
    expect(sessions.size).toBe(0);
    // A header scheme override puts the credential where the server wants it.
    const hdr = ctx({ authScheme: 'header:X-Api-Key' }, { credential: 'k' });
    seenAuth.length = 0;
    await walk(c, hdr);
    expect(seenAuth.every((a) => a === '')).toBe(true);
    await c.endRun(hdr);
  });

  it('refuses by name: a pinned url that is not the operator’s, an oauth entry, a vanished entry, the egress fence', async () => {
    const c = new McpConnector();
    const pinned = ctx({}, { source: { ...ENTRY, url: `${base}/mcp` } });
    expect(upserts(await walk(c, pinned))).toHaveLength(4);
    await c.endRun(pinned);
    await expect(walk(c, ctx({}, { source: { ...ENTRY, auth: 'oauth' } }))).rejects.toThrow(
      'not available yet (W4)',
    );
    await expect(walk(c, ctx({}, { source: null }))).rejects.toThrow(
      'no longer declares http MCP source',
    );
    await expect(walk(c, ctx({ url: undefined }))).rejects.toThrow('config.url is not set');
    // Without the connection's half of the double opt-in a loopback server is refused.
    await expect(walk(c, ctx({ allowPrivate: false }))).rejects.toThrow(
      /must use https|non-public/,
    );
  });

  it('the kind switch makes the connector "not installed" by name', () => {
    const c = new McpConnector();
    expect(c.enabled()).toBe(true);
    delete process.env.SOURCE_KIND_MCP;
    expect(c.enabled()).toBe(false);
    process.env.SOURCE_KIND_MCP = '1';
  });
});
