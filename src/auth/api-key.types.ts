export type BrainScope =
  | 'brain:read'
  | 'brain:write'
  | 'brain:admin'
  | 'brain:read_pii'
  // Publish/yank in the GLOBAL pack registry — distinct from brain:admin
  // ("operate my tenant") because it mutates the catalogue shared across all
  // tenants. Discovery reads use brain:read; installing from the registry into
  // a tenant uses brain:admin.
  | 'registry:publish'
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
  /** Optional human label. */
  name?: string;
  /**
   * ABAC policy set names this key carries directly — from the optional
   * `policies` field of a BRAIN_API_KEYS entry or the `policy` claim of
   * a JWT. Unioned with policy_binding rows by PolicyResolverService.
   */
  policyNames?: string[];
}

export interface AuthenticatedRequest {
  brainAuth: {
    companyId: string;
    scopes: BrainScope[];
    keyHash: string;
    /**
     * Resolved+compiled ABAC context; undefined when ABAC is disabled
     * or the key references no policy sets (= pre-ABAC behavior).
     */
    policy?: import('../policy/policy.types').PolicyContext;
  };
}
