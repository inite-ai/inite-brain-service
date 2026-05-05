import type { StartedTestContainer } from 'testcontainers';

declare global {
   
  var __SURREAL_CONTAINER__: StartedTestContainer | undefined;
}

export default async function teardown() {
  const c = globalThis.__SURREAL_CONTAINER__;
  if (c) {
    await c.stop({ remove: true, removeVolumes: true });
    console.log('[e2e] SurrealDB container stopped');
  }
}
