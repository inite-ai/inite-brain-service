export type BrainScope =
  | 'brain:read'
  | 'brain:write'
  | 'brain:admin'
  | 'brain:read_pii'
  // Cross-tenant (company-level) operator authority — distinct from and
  // strictly HIGHER than brain:admin ("operate MY tenant"). Required for
  // any admin op that addresses a tenant other than the credential's own
  // (with BRAIN_TENANT_OVERRIDE_ENABLED). Hosting-operator only: granted
  // via env-key config like registry:curate, deliberately NOT added to
  // the jwks VALID_SCOPES set (never mintable through the token path).
  | 'brain:platform_admin'
  // Publish/yank in the GLOBAL pack registry — distinct from brain:admin
  // ("operate my tenant") because it mutates the catalogue shared across all
  // tenants. Discovery reads use brain:read; installing from the registry into
  // a tenant uses brain:admin.
  | 'registry:publish'
  // Hosting-operator curation of the GLOBAL registry (feature/unfeature) —
  // distinct from registry:publish: publishers manage their own packs,
  // curation ranks everyone's. Env-key-only like registry:publish —
  // deliberately NOT added to the jwks VALID_SCOPES set.
  | 'registry:curate'
  // Stage candidates for a document as an EXTERNAL indexer — deliberately
  // narrower than brain:write: the key can propose hypotheses
  // (POST /v1/documents/:id/candidates), never commit facts directly.
  // Granted per external-indexer integration.
  | 'indexer:write';

export interface ApiKeyRecord {
  /** SHA-256 hex hash of the plaintext key (never store plaintext). */
  keyHash: string;
  companyId: string;
  scopes: BrainScope[];
  /**
   * End-user identity for user-bound tokens: the auth-service stamps
   * `org` (tenant) + `sub` (user did) on user-flow and token-exchange
   * tokens, and this field carries the sub. Absent for M2M credentials
   * (client_credentials, static keys), where sub IS the tenant. Drives
   * per-user memory scoping — see pinUserScope().
   */
  userId?: string;
  /**
   * Plan/tier entitlements from the token's `entitlements` claim —
   * feeds tier-aware throttling. Absent = default tier.
   */
  entitlements?: string[];
  /**
   * Identity of the ACTING client (the agent): RFC 8693 `act`, falling
   * back to the token's `client_id`. Drives provenance attribution
   * (source.meta.actor / mcp_agent:<id> recorder) and `agent:<id>`
   * policy bindings. Absent for static keys.
   */
  actorId?: string;
  /**
   * RFC 9396 inite_mcp_resource grant — the union of MCP actions the
   * user consented to for this deployment. undefined = no grant claim,
   * gate inactive (scopes/ABAC only); empty = granted nothing (every
   * tool removed) — foreign-location grants fail closed this way.
   */
  mcpGrantedActions?: string[];
  /** Optional human label. */
  name?: string;
  /**
   * ABAC policy set names this key carries directly — from the optional
   * `policies` field of a BRAIN_API_KEYS entry or the `policy` claim of
   * a JWT. Unioned with policy_binding rows by PolicyResolverService.
   */
  policyNames?: string[];
  /**
   * Optional per-pack binding for `indexer:write` keys — from the
   * `packIds` field of a BRAIN_API_KEYS entry or the `packs` claim of a
   * JWT. A bound key can poll/claim/read/submit ONLY for these packs;
   * absent = every external pack installed for the tenant (pre-binding
   * behavior). Hardening: one integration's leaked key can't stage
   * candidates as another integration's identity.
   */
  packIds?: string[];
}

export interface AuthenticatedRequest {
  brainAuth: {
    companyId: string;
    scopes: BrainScope[];
    keyHash: string;
    /** End-user of a user-bound token; absent for M2M credentials. */
    userId?: string;
    /** Acting client (agent) identity; see ApiKeyRecord.actorId. */
    actorId?: string;
    /** RFC 9396 MCP grant; see ApiKeyRecord.mcpGrantedActions. */
    mcpGrantedActions?: string[];
    /** Per-pack binding of an indexer key; absent = all external packs. */
    packIds?: string[];
    /**
     * Resolved+compiled ABAC context; undefined when ABAC is disabled
     * or the key references no policy sets (= pre-ABAC behavior).
     */
    policy?: import('../policy/policy.types').PolicyContext;
  };
}
