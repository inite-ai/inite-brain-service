/**
 * An MCP source that signs in (auth: 'oauth') binds its grant to the
 * server it was made for. `update()` used to re-check the credential only
 * when the patch carried one — so `{ config: { url } }` alone moved a
 * connection, grant and all, to another server, and the grant's access
 * token would have been sent there (code-scanning js/user-controlled-bypass).
 */
import { BadRequestException } from '@nestjs/common';
import type { SurrealService } from '../src/db/surreal.service';
import type { SourceOAuthService } from '../src/source-plane/oauth/source-oauth.service';
import {
  SourceConnectionService,
  type SourceConnectionRow,
} from '../src/source-plane/source-connection.service';
import type { SourcesService } from '../src/sources/sources.service';

const GOOD = 'https://good.example/mcp';

function harness(): { svc: SourceConnectionService; updates: string[] } {
  const current = {
    id: 'source_connection:c1',
    packId: 'acme-pack',
    sourceId: 'notes',
    kind: 'mcp',
    connector: 'mcp',
    shape: 'documents',
    host: 'server',
    config: { url: GOOD },
    credential: 'oauth:g1',
    mode: 'synced',
    status: 'active',
    vertical: 'general',
  } as unknown as SourceConnectionRow;
  const updates: string[] = [];
  const db = {
    query: async (sql: string) => {
      if (sql.includes('FROM domain_pack')) {
        return [
          [
            {
              manifest: {
                sources: [{ id: 'notes', kind: 'mcp', transport: 'http', auth: 'oauth' }],
              },
            },
          ],
        ];
      }
      if (sql.startsWith('UPDATE')) {
        updates.push(sql);
        return [[current]];
      }
      return [[current]];
    },
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
  const oauth = {
    get: async () => ({ provider: 'mcp', resource: GOOD, status: 'active' }),
  } as unknown as SourceOAuthService;
  const svc = new SourceConnectionService(
    surreal,
    {} as SourcesService,
    undefined,
    undefined,
    oauth,
  );
  return { svc, updates };
}

describe('source connection update — the credential fence follows the server', () => {
  it('refuses to move a signed-in MCP connection to another server without a new grant', async () => {
    const { svc, updates } = harness();
    await expect(
      svc.update('co', 'c1', { config: { url: 'https://evil.example/mcp' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('lets a config change that keeps the same server through', async () => {
    const { svc, updates } = harness();
    await svc.update('co', 'c1', { config: { url: GOOD, extra: 1 } });
    expect(updates).toHaveLength(1);
  });

  it('lets a label-only change through without touching the credential', async () => {
    const { svc, updates } = harness();
    await svc.update('co', 'c1', { label: 'renamed' });
    expect(updates).toHaveLength(1);
  });
});
