/**
 * The connect-time half of the source plane's SSRF fence. The pre-flight
 * check resolves a host once; the socket used to resolve it again, so a
 * zero-TTL name could answer public to the check and private to the
 * connect (DNS rebinding — code-scanning js/request-forgery). The
 * socket's own lookup now judges the addresses it dials.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EgressDeniedError } from '../src/common/egress-guard';
import {
  guardedLookup,
  pinnedRequest,
  refusedAddress,
} from '../src/source-plane/connectors/pinned-request';

describe('refusedAddress', () => {
  it.each([
    ['127.0.0.1', 4],
    ['10.1.2.3', 4],
    ['169.254.169.254', 4],
    ['::1', 6],
    ['::ffff:169.254.169.254', 6],
    ['::ffff:a9fe:a9fe', 6],
    ['::ffff:7f00:1', 6],
    ['fe80::1', 6],
  ])('the public policy refuses %s', (address, family) => {
    expect(refusedAddress('public', address, family)).toBe(true);
  });

  it('the public policy lets a public address through', () => {
    expect(refusedAddress('public', '93.184.216.34', 4)).toBe(false);
  });

  it('the private opt-in still refuses the metadata range, and only it', () => {
    expect(refusedAddress('not-link-local', '169.254.169.254', 4)).toBe(true);
    expect(refusedAddress('not-link-local', '::ffff:169.254.169.254', 6)).toBe(true);
    expect(refusedAddress('not-link-local', 'fe80::1', 6)).toBe(true);
    expect(refusedAddress('not-link-local', '127.0.0.1', 4)).toBe(false);
    expect(refusedAddress('not-link-local', '192.168.1.5', 4)).toBe(false);
  });
});

describe('guardedLookup', () => {
  it('refuses a name that resolves to loopback at connect time', async () => {
    const lookup = guardedLookup('public');
    const err = await new Promise<Error | null>((resolve) =>
      lookup('localhost', { all: true }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(EgressDeniedError);
  });
});

describe('pinnedRequest', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('x-method', req.method ?? '');
      res.end(`hello ${req.headers['content-length'] ?? '-'}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('never connects to a name that resolves private under the public policy', async () => {
    // No pre-flight here: this is the socket's own check — what a rebound
    // name meets after it passed the pre-flight with a public answer.
    await expect(pinnedRequest(`http://localhost:${port}/`, {}, 'public')).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
  });

  it('reaches a LAN host under the private opt-in and returns a fetch Response', async () => {
    const res = await pinnedRequest(
      `http://localhost:${port}/`,
      { method: 'POST', body: 'abc' },
      'not-link-local',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-method')).toBe('POST');
    expect(await res.text()).toBe('hello 3');
  });
});
