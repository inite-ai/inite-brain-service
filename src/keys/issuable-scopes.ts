import { BrainScope } from '../auth/api-key.types';

/**
 * The scopes a caller may put on a key it mints.
 *
 * Everything else brain understands — `brain:platform_admin`,
 * `brain:read_media`, `registry:publish`, `registry:curate`,
 * `indexer:write` — is hosting-operator authority, granted through
 * operator configuration and deliberately not mintable through a
 * credential. Same rule the JWKS VALID_SCOPES set enforces for tokens;
 * a key-issuing endpoint that ignored it would be the way around it.
 */
export const ISSUABLE_SCOPES: readonly BrainScope[] = [
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
] as const;

/**
 * What this caller is allowed to grant: the issuable set intersected
 * with what the caller itself holds. A key can never be wider than the
 * credential that asked for it.
 */
export function issuableFor(callerScopes: readonly BrainScope[]): BrainScope[] {
  const held = new Set<string>(callerScopes);
  return ISSUABLE_SCOPES.filter((scope) => held.has(scope));
}
