/**
 * The MCP server reports the release it is, not a frozen number.
 *
 * MCP_SERVER_VERSION was a hand-kept '0.3.0' while package.json went to
 * 2.x: every client's serverInfo said 0.3.0 whatever was deployed. It is
 * now the release version (src/common/service-version.ts, the same
 * reader /health uses), checked here where a client sees it: the
 * `initialize` handshake and the unauthenticated health probe.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_SERVER_VERSION, McpService } from '../src/mcp/mcp.service';

const packageVersion = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

function service(): McpService {
  const none = {} as never;
  const embedder = { cacheStats: () => ({ provider: 'test' }), getDimensions: () => 0 };
  const reader = { isActive: async () => false, installedPackTools: async () => [] };
  return new McpService(
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    embedder as never,
    none,
    none,
    none,
    reader as never,
    none,
  );
}

describe('MCP server version', () => {
  it('is the package.json release', () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(MCP_SERVER_VERSION).toBe(packageVersion);
  });

  it('is what `initialize` reports as serverInfo', async () => {
    const server = await service().buildServer('co_version', ['brain:read']);
    const client = new Client({ name: 'version-check', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'inite-brain-service',
        version: packageVersion,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('is what the health probe reports, beside the same serviceVersion', () => {
    const health = service().health();
    expect(health.version).toBe(packageVersion);
    expect(health.serviceVersion).toBe(packageVersion);
  });
});
