import { createServer } from 'node:net';
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers';

declare global {
  var __SURREAL_CONTAINER__: StartedTestContainer | undefined;
}

export default async function setup() {
  // Skip Docker if a SurrealDB URL is already provided (CI-style override).
  if (process.env.SURREALDB_URL) {
    console.log(`[e2e] using preconfigured SurrealDB at ${process.env.SURREALDB_URL}`);
    return;
  }

  console.log('[e2e] starting ephemeral SurrealDB container...');
  // A FIXED host port, chosen free right now, rather than Docker's ephemeral
  // `-p 0:8000`: an ephemeral mapping is re-drawn on `docker restart`, so a
  // spec that restarts the database underneath the app would come back on a
  // different URL — which is not what happens in production (a compose
  // service keeps its name and port) and would test nothing about recovery.
  const hostPort = await freePort();
  const container = await new GenericContainer('surrealdb/surrealdb:v3.2.4')
    .withUser('root')
    .withCommand([
      'start',
      '--user=root',
      '--pass=root',
      '--bind=0.0.0.0:8000',
      // rocksdb backend mirrors production. The memory backend has
      // a known weak-isolation window on UNIQUE indexes under
      // concurrent CREATEs that production never hits.
      'rocksdb:/tmp/surreal_e2e_db',
    ])
    .withExposedPorts({ container: 8000, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Started web server/, 1))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(8000);
  process.env.SURREALDB_URL = `ws://${host}:${port}`;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = 'root';
  process.env.SURREALDB_NAMESPACE = 'brain';

  // The container id, so a spec can restart the database underneath the
  // app (recovery tests). Env set here is inherited by every jest worker;
  // the container handle itself is not — global setup runs in the parent.
  process.env.SURREALDB_CONTAINER_ID = container.getId();
  globalThis.__SURREAL_CONTAINER__ = container;
  console.log(`[e2e] SurrealDB ready at ${process.env.SURREALDB_URL}`);
}

/** A host port nobody is listening on at this moment. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
