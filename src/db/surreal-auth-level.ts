import type { ConfigService } from '@nestjs/config';

/**
 * SURREALDB_AUTH_LEVEL — the level brain's privileged SurrealDB user is
 * defined at: `root` (default, a root user) or `namespace` (a namespace
 * OWNER of SURREALDB_NAMESPACE, created by the operator with
 * `DEFINE USER … ON NAMESPACE … ROLES OWNER`). A shared server gives each
 * application its own least-privilege user; anything but `namespace`
 * resolves to `root`.
 */
export type SurrealAuthLevel = 'root' | 'namespace';

export function surrealAuthLevel(config: Pick<ConfigService, 'get'>): SurrealAuthLevel {
  const raw = config.get<string>('SURREALDB_AUTH_LEVEL')?.trim().toLowerCase();
  return raw === 'namespace' ? 'namespace' : 'root';
}
