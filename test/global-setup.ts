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
  const container = await new GenericContainer('surrealdb/surrealdb:v2.2.8')
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
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forLogMessage(/Started web server/, 1))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(8000);
  process.env.SURREALDB_URL = `ws://${host}:${port}`;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = 'root';
  process.env.SURREALDB_NAMESPACE = 'brain';

  globalThis.__SURREAL_CONTAINER__ = container;
  console.log(`[e2e] SurrealDB ready at ${process.env.SURREALDB_URL}`);
}
