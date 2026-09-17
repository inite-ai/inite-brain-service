/**
 * UrlConnector against a local HTTP server (a private host, so the
 * double opt-in is exercised on every path):
 *  - without SOURCE_EGRESS_ALLOW_PRIVATE + allowPrivate, a loopback
 *    sitemap is refused by the egress guard;
 *  - sitemaps and one level of sitemap index enumerate their <loc>s with
 *    <lastmod> as revision; robots Disallow prefixes are honoured;
 *    sameHostOnly drops a foreign host; maxPages bounds the walk;
 *  - a page without lastmod gets its revision from the server (ETag),
 *    else a time bucket;
 *  - fetch reduces HTML to text with the <title>, passes text/plain,
 *    hands a PDF to the binary shape only, refuses other types;
 *  - a redirect hop into a refused host is caught at the hop;
 *  - a body over maxBytes is refused;
 *  - the credential rides as Authorization (bearer / basic / header:).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EgressDeniedError } from '../src/common/egress-guard';
import { htmlToText } from '../src/common/html-text';
import { UrlConnector, locs } from '../src/source-plane/connectors/url.connector';
import { parseRobots } from '../src/source-plane/connectors/robots';
import { safeFetch } from '../src/source-plane/connectors/safe-fetch';
import type { ConnectorCtx, ItemDelta } from '../src/source-plane/connector';

let server: Server;
let base = '';
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }> = [];

function route(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  const url = new URL(req.url ?? '/', base);
  const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  switch (url.pathname) {
    case '/robots.txt':
      return send(200, 'text/plain', 'User-agent: *\nDisallow: /private/\nUser-agent: inite-brain-source\nDisallow: /nobrain\n');
    case '/sitemap.xml':
      return send(200, 'application/xml', `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>${base}/missing.xml</loc></sitemap>
</sitemapindex>`);
    case '/sitemap-a.xml':
      return send(200, 'application/xml', `<urlset>
  <url><loc>${base}/docs/intro</loc><lastmod>2026-03-01</lastmod></url>
  <url><loc>${base}/docs/etag</loc></url>
  <url><loc>${base}/docs/plain.txt</loc><lastmod>2026-03-02T10:00:00Z</lastmod></url>
  <url><loc>${base}/private/secret</loc><lastmod>2026-03-01</lastmod></url>
  <url><loc>${base}/nobrain</loc></url>
  <url><loc>https://elsewhere.example/page</loc></url>
  <url><loc>${base}/docs/no-hints</loc></url>
</urlset>`);
    case '/docs/intro':
      return send(200, 'text/html; charset=utf-8', '<html><head><title>Intro &amp; more</title><style>x{}</style></head><body><h1>Welcome</h1><script>bad()</script><p>Read <a href="/docs/etag">the etag page</a>.</p></body></html>', { 'last-modified': 'Mon, 02 Mar 2026 10:00:00 GMT' });
    case '/docs/etag':
      return send(200, 'text/html', '<p>etag page</p>', { etag: 'W/"abc123"' });
    case '/docs/plain.txt':
      return send(200, 'text/plain', 'plain text page');
    case '/docs/no-hints':
      return send(200, 'text/html', '<p>no hints</p>');
    case '/docs/file.pdf':
      return send(200, 'application/pdf', Buffer.from('%PDF-1.4 fake'));
    case '/docs/blob':
      return send(200, 'application/octet-stream', Buffer.from([1, 2, 3]));
    case '/big':
      return send(200, 'text/plain', 'x'.repeat(2048));
    case '/bounce':
      return send(302, 'text/plain', '', { location: 'http://169.254.169.254/latest/meta-data/' });
    case '/hop':
      return send(302, 'text/plain', '', { location: `${base}/docs/plain.txt` });
    default:
      return send(404, 'text/plain', 'nope');
  }
}

function ctx(config: Record<string, unknown>, over: { shape?: 'document' | 'binary'; credential?: string } = {}): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:c1',
      packId: 'web_memory',
      sourceId: 'site',
      kind: 'native',
      connector: 'url',
      shape: over.shape ?? 'document',
      host: 'server',
      config: { allowPrivate: true, ...config },
      credential: over.credential ?? null,
      contentPolicy: 'text',
      vertical: 'web',
      recorder: 'srcconn_c1',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function walk(c: UrlConnector, x: ConnectorCtx): Promise<ItemDelta[]> {
  const out: ItemDelta[] = [];
  for await (const d of c.enumerate(x, { checkpoint: null, full: true })) out.push(d);
  return out;
}
const upserts = (deltas: ItemDelta[]) =>
  deltas.filter((d): d is Extract<ItemDelta, { type: 'upsert' }> => d.type === 'upsert');

describe('UrlConnector', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    server = createServer(route);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const k of ['SOURCE_EGRESS_ALLOW_PRIVATE', 'SOURCE_KIND_URL']) saved[k] = process.env[k];
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    process.env.SOURCE_KIND_URL = '1';
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  it('refuses a private host without the double opt-in — either half alone', async () => {
    const c = new UrlConnector();
    delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    await expect(walk(c, ctx({ sitemaps: [`${base}/sitemap.xml`] }))).rejects.toThrow(EgressDeniedError);
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    await expect(walk(c, ctx({ sitemaps: [`${base}/sitemap.xml`], allowPrivate: false }))).rejects.toThrow(EgressDeniedError);
    expect(seen).toHaveLength(0);
  });

  it('enumerates a sitemap index: lastmod as revision, robots and sameHostOnly honoured', async () => {
    const c = new UrlConnector();
    const deltas = await walk(c, ctx({ sitemaps: [`${base}/sitemap.xml`] }));
    const items = upserts(deltas).map((d) => d.item);
    expect(items.map((i) => i.path)).toEqual(['/docs/intro', '/docs/etag', '/docs/plain.txt', '/docs/no-hints']);
    expect(items[0]).toMatchObject({ externalId: `${base}/docs/intro`, revision: '2026-03-01', modifiedAt: '2026-03-01T00:00:00.000Z' });
    expect(items[1]!.revision).toBe('etag:abc123');
    expect(items[3]!.revision).toMatch(/^t:\d+$/);
    expect(deltas.at(-1)).toMatchObject({ type: 'checkpoint', checkpoint: { pages: 4 } });
    // robots.txt fetched once; HEADs only for pages without lastmod
    expect(seen.filter((r) => r.url === '/robots.txt')).toHaveLength(1);
    expect(seen.filter((r) => r.method === 'HEAD').map((r) => r.url)).toEqual(['/docs/etag', '/docs/no-hints']);
  });

  it('maxPages bounds the walk; explicit urls join the sitemap set; ignoreRobots opens /private', async () => {
    const c = new UrlConnector();
    expect(upserts(await walk(c, ctx({ sitemaps: [`${base}/sitemap-a.xml`], maxPages: 2 })))).toHaveLength(2);
    const items = upserts(await walk(c, ctx({ urls: [`${base}/docs/plain.txt#frag`], sitemaps: [`${base}/sitemap-a.xml`], ignoreRobots: true }))).map((d) => d.item.path);
    expect(items).toEqual(['/docs/plain.txt', '/docs/intro', '/docs/etag', '/private/secret', '/nobrain', '/docs/no-hints']);
  });

  it('fetch reduces HTML to text with the title; passes text; PDFs need the binary shape', async () => {
    const c = new UrlConnector();
    const x = ctx({ urls: [`${base}/docs/intro`] });
    const page = await c.fetch(x, { externalId: `${base}/docs/intro` });
    expect(page).toEqual({
      shape: 'document',
      text: 'Welcome\nRead the etag page .',
      title: 'Intro & more',
      occurredAt: '2026-03-02T10:00:00.000Z',
      kind: 'web_page',
    });
    expect(await c.fetch(x, { externalId: `${base}/docs/plain.txt` })).toMatchObject({ shape: 'document', text: 'plain text page' });
    await expect(c.fetch(x, { externalId: `${base}/docs/file.pdf` })).rejects.toThrow('binary-shaped');
    const pdf = await c.fetch(ctx({ urls: [] , sitemaps: [`${base}/sitemap-a.xml`] }, { shape: 'binary' }), { externalId: `${base}/docs/file.pdf` });
    expect(pdf).toMatchObject({ shape: 'binary', mediaType: 'application/pdf', modality: 'document' });
    await expect(c.fetch(x, { externalId: `${base}/docs/blob` })).rejects.toThrow('unsupported content-type');
    await expect(c.fetch(x, { externalId: `${base}/missing` })).rejects.toThrow('HTTP 404');
  });

  it('a redirect into a refused host is caught at the hop; a same-host redirect is followed; size caps hold', async () => {
    await expect(safeFetch(`${base}/bounce`, { allowPrivate: true })).rejects.toThrow(EgressDeniedError);
    const hop = await safeFetch(`${base}/hop`, { allowPrivate: true });
    expect(hop.url).toBe(`${base}/docs/plain.txt`);
    expect(hop.body.toString()).toBe('plain text page');
    await expect(safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1024 })).rejects.toThrow('over 1024 bytes');
  });

  it('the credential rides as Authorization (bearer / basic / header:)', async () => {
    const c = new UrlConnector();
    await c.fetch(ctx({ urls: [base] }, { credential: 'tok' }), { externalId: `${base}/docs/plain.txt` });
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer tok');
    await c.fetch(ctx({ urls: [base], authScheme: 'basic' }, { credential: 'u:p' }), { externalId: `${base}/docs/plain.txt` });
    expect(seen.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    await c.fetch(ctx({ urls: [base], authScheme: 'header:X-Api-Key' }, { credential: 'k' }), { externalId: `${base}/docs/plain.txt` });
    expect(seen.at(-1)!.headers['x-api-key']).toBe('k');
    expect(seen.at(-1)!.headers['user-agent']).toBe('inite-brain-source/1.0');
  });

  it('pure helpers: locs, parseRobots, htmlToText', () => {
    expect(locs('<urlset><url><loc> https://a/x </loc><lastmod>2026-01-01</lastmod></url><url><loc>https://a/y&amp;z</loc></url></urlset>')).toEqual([
      { loc: 'https://a/x', lastmod: '2026-01-01' },
      { loc: 'https://a/y&z' },
    ]);
    expect(parseRobots('User-agent: other\nDisallow: /x\nUser-agent: *\nDisallow: /a\nDisallow:\n# c\nUser-agent: inite-brain-source/1.0\nDisallow: /b')).toEqual(['/a', '', '/b']);
    expect(htmlToText('<title>T</title><p>a&nbsp;b</p><br><div>c</div>')).toEqual({ title: 'T', body: 'a b\nc' });
  });
});
