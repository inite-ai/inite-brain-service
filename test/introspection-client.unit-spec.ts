/**
 * IntrospectionClient — opaque ik_… key resolution via a locally-served
 * RFC 7662 endpoint. Covers the claim mapping (org/sub → tenant/user),
 * audience binding, the introspected scope allow-list, and the answer
 * cache. No real auth-service, no SurrealDB.
 */
import * as http from 'node:http';
import { ConfigService } from '@nestjs/config';
import {
  IntrospectionClient,
  mapIntrospectionRecord,
} from '../src/auth/introspection.client';

class StubConfig {
  constructor(private readonly map: Record<string, string>) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
}

describe('mapIntrospectionRecord', () => {
  const hash = 'deadbeef';

  it('maps an org-bound key: tenant = org, no userId', () => {
    const rec = mapIntrospectionRecord(
      { active: true, sub: 'co_acme', org: 'co_acme', aud: 'brain', scope: 'brain:read brain:write' },
      hash,
      'brain',
    );
    expect(rec).toMatchObject({
      companyId: 'co_acme',
      scopes: ['brain:read', 'brain:write'],
      keyHash: 'introspect:deadbeef',
    });
    expect(rec?.userId).toBeUndefined();
  });

  it('carries policy set names from the introspection answer', () => {
    const rec = mapIntrospectionRecord(
      {
        active: true,
        sub: 'co_acme',
        org: 'co_acme',
        aud: 'brain',
        scope: 'brain:read',
        policy: ['support-reader', 'BAD NAME!'],
      },
      hash,
      'brain',
    );
    expect(rec?.policyNames).toEqual(['support-reader']);
  });

  it('maps a user-bound key: tenant = org, userId = sub', () => {
    const rec = mapIntrospectionRecord(
      { active: true, sub: 'did:key:z6MkUser', org: 'co_acme', aud: 'brain', scope: 'brain:read' },
      hash,
      'brain',
    );
    expect(rec?.companyId).toBe('co_acme');
    expect(rec?.userId).toBe('did:key:z6MkUser');
  });

  it('rejects inactive, foreign-audience, and scope-less answers', () => {
    expect(
      mapIntrospectionRecord({ active: false }, hash, 'brain'),
    ).toBeNull();
    expect(
      mapIntrospectionRecord(
        { active: true, sub: 'co_a', org: 'co_a', aud: 'inbox', scope: 'brain:read' },
        hash,
        'brain',
      ),
    ).toBeNull();
    expect(
      mapIntrospectionRecord(
        { active: true, sub: 'co_a', org: 'co_a', aud: 'brain', scope: '' },
        hash,
        'brain',
      ),
    ).toBeNull();
  });

  it('allows integration scopes (indexer:write, registry:publish, registry:curate) and drops unknown ones', () => {
    const rec = mapIntrospectionRecord(
      {
        active: true,
        sub: 'co_a',
        org: 'co_a',
        aud: 'brain',
        scope: 'indexer:write registry:publish registry:curate made:up',
      },
      hash,
      'brain',
    );
    expect(rec?.scopes).toEqual([
      'indexer:write',
      'registry:publish',
      'registry:curate',
    ]);
  });
});

describe('IntrospectionClient (HTTP + cache)', () => {
  let server: http.Server;
  let url: string;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          active: true,
          sub: 'co_acme',
          org: 'co_acme',
          aud: 'brain',
          scope: 'brain:read',
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}/introspect`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('resolves via HTTP once and serves the repeat from cache', async () => {
    const client = new IntrospectionClient({
      url,
      clientId: 'brain-service',
      clientSecret: 's3cret',
      audience: 'brain',
    });
    const first = await client.resolve('ik_test_key');
    const second = await client.resolve('ik_test_key');
    expect(first?.companyId).toBe('co_acme');
    expect(second?.companyId).toBe('co_acme');
    expect(hits).toBe(1);
  });

  it('fromConfig returns null when credentials are missing', () => {
    const none = IntrospectionClient.fromConfig(
      new StubConfig({}) as unknown as ConfigService,
    );
    expect(none).toBeNull();

    const configured = IntrospectionClient.fromConfig(
      new StubConfig({
        AUTH_SERVICE_URL: 'https://auth.test',
        AUTH_SERVICE_INTROSPECTION_CLIENT_ID: 'brain-service',
        AUTH_SERVICE_INTROSPECTION_CLIENT_SECRET: 's3cret',
      }) as unknown as ConfigService,
    );
    expect(configured).not.toBeNull();
  });
});
