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
  const container = await new GenericContainer('surrealdb/surrealdb:v2.1.4')
    .withCommand([
      'start',
      '--user=root',
      '--pass=root',
      '--bind=0.0.0.0:8000',
      'memory',
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
