import type { StartedTestContainer } from 'testcontainers';

declare global {
  // eslint-disable-next-line no-var
  var __SURREAL_CONTAINER__: StartedTestContainer | undefined;
}

export default async function teardown() {
  const c = globalThis.__SURREAL_CONTAINER__;
  if (c) {
    await c.stop({ remove: true, removeVolumes: true });
    console.log('[e2e] SurrealDB container stopped');
  }
}
