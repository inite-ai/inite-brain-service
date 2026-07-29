/**
 * Minimal brain HTTP client pinned to one tenant via X-Brain-Tenant
 * (requires BRAIN_TENANT_OVERRIDE_ENABLED on the brain and an
 * admin-scoped key). One instance = one isolated eval world.
 */
export class TenantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly tenant: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Brain-Tenant': this.tenant,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}
