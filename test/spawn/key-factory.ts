import { createHash, randomUUID } from 'node:crypto';

/**
 * Issues a plaintext API key plus its server-side hash + scope record.
 * Pure factory — used by spawn-service to build the BRAIN_API_KEYS env.
 */
export interface BrainKeySpec {
  plaintext: string;
  keyHash: string;
  companyId: string;
  scopes: string[];
}

export function newBrainKey(companyId: string, scopes: string[]): BrainKeySpec {
  const plaintext = `key_${randomUUID()}`;
  const keyHash = 'sha256:' + createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, keyHash, companyId, scopes };
}

export function newCompanyId(): string {
  return `co_real_${Date.now()}_${randomUUID().slice(0, 4)}`;
}
