/** The fast failure an open circuit gives when there is no fallback to route to. */
export class ProviderCircuitOpen extends Error {
  readonly status = 503;
  readonly code = 'provider_circuit_open';
  constructor(route: string) {
    super(`model provider ${route} is failing; calls are paused until a probe succeeds`);
    this.name = 'ProviderCircuitOpen';
  }
}
