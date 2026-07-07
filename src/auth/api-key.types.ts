export type BrainScope =
  | 'brain:read'
  | 'brain:write'
  | 'brain:admin'
  | 'brain:read_pii'
  // Publish/yank in the GLOBAL pack registry — distinct from brain:admin
  // ("operate my tenant") because it mutates the catalogue shared across all
  // tenants. Discovery reads use brain:read; installing from the registry into
  // a tenant uses brain:admin.
  | 'registry:publish';

export interface ApiKeyRecord {
  /** SHA-256 hex hash of the plaintext key (never store plaintext). */
  keyHash: string;
  companyId: string;
  scopes: BrainScope[];
  /** Optional human label. */
  name?: string;
}

export interface AuthenticatedRequest {
  brainAuth: {
    companyId: string;
    scopes: BrainScope[];
    keyHash: string;
  };
}
