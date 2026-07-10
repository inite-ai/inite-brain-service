import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { PolicyStoreService } from './policy-store.service';
import { MAX_SETS_PER_KEY } from './policy.types';

export interface AdminKeySummary {
  /** Short non-secret display id — first 12 hex of the sha256 hash. */
  keyId: string;
  /** Full binding subject (`key:<keyHash>`) for the attachments API. */
  subject: string;
  name?: string;
  scopes: string[];
  policySets: Array<{ name: string; mode: string }>;
}

/**
 * Tenant key inventory + subject resolution for the ABAC admin UI.
 * Static keys only (BRAIN_API_KEYS / env) — JWT-minted keys have no
 * standing inventory to list; their policies ride the `policy` claim.
 */
@Injectable()
export class PolicyKeysService {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly store: PolicyStoreService,
  ) {}

  async listKeys(companyId: string): Promise<AdminKeySummary[]> {
    const records = this.apiKeys.listForCompany(companyId);
    if (records.length === 0) return [];
    const [bindings, sets] = await Promise.all([
      this.store.listBindings(companyId),
      this.store.list(companyId),
    ]);
    const bindingBySubject = new Map(
      bindings.map((b) => [b.subject, b.policyNames]),
    );
    const modeByName = new Map(sets.map((s) => [s.name, s.mode]));

    return records.map((r) => {
      const subject = `key:${r.keyHash}`;
      const names = [
        ...new Set([
          ...(bindingBySubject.get(subject) ?? []),
          ...(r.policyNames ?? []),
        ]),
      ].slice(0, MAX_SETS_PER_KEY);
      return {
        keyId: keyIdOf(r.keyHash),
        subject,
        ...(r.name ? { name: r.name } : {}),
        scopes: r.scopes,
        policySets: names.map((name) => ({
          name,
          mode: modeByName.get(name) ?? 'missing',
        })),
      };
    });
  }

  /**
   * keyId (12-hex display id) → the policy set names the key would
   * resolve at request time. Used by the simulation subject form
   * `{keyId}` so the UI can simulate "what does THIS key see".
   */
  async policyNamesForKeyId(
    companyId: string,
    keyId: string,
  ): Promise<{ keyId: string; policyNames: string[] }> {
    const keys = await this.listKeys(companyId);
    const found = keys.find((k) => k.keyId === keyId);
    if (!found) {
      throw new NotFoundException(`Key '${keyId}' not found for this tenant`);
    }
    return { keyId, policyNames: found.policySets.map((s) => s.name) };
  }
}

export function keyIdOf(keyHash: string): string {
  return keyHash.replace(/^sha256:/, '').slice(0, 12);
}
