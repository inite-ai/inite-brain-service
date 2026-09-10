import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiKeyStoreService,
  ApiKeySummary,
  MAX_ACTIVE_KEYS_PER_TENANT,
} from '../auth/api-key-store.service';
import { ApiKeyRecord, BrainScope } from '../auth/api-key.types';
import { issuableFor } from './issuable-scopes';

/** What the caller asked for, before any narrowing. */
export interface IssueRequest {
  name: string;
  scopes: string[];
  expiresInDays?: number;
  userId?: string;
}

/**
 * Self-serve key issuance — the rules, so the controller stays HTTP.
 *
 * Two invariants live here:
 *
 *   1. **A key is never wider than the credential that minted it.** The
 *      requested scopes are intersected with the caller's own, after the
 *      non-delegable operator scopes are removed. Ask for more and you
 *      get less, silently; ask for nothing you hold and it is a 400.
 *   2. **A user-bound caller can only mint keys for itself.** Only a
 *      caller holding `brain:admin` — "operate MY tenant" — may bind a
 *      key to another user or see the tenant's other keys. Everyone else
 *      sees and revokes their own.
 *
 * The tenant boundary itself is not decided here: companyId always comes
 * from the authenticated record, never from the request body.
 */
@Injectable()
export class KeysService {
  constructor(private readonly store: ApiKeyStoreService) {}

  enabled(): boolean {
    return this.store.enabled();
  }

  issuableScopes(auth: ApiKeyRecord): BrainScope[] {
    return issuableFor(auth.scopes);
  }

  async issue(auth: ApiKeyRecord, request: IssueRequest) {
    this.requireStore();
    const allowed = new Set<string>(this.issuableScopes(auth));
    const scopes = request.scopes.filter((scope) => allowed.has(scope)) as BrainScope[];
    if (scopes.length === 0) {
      throw new ForbiddenException(
        `None of the requested scopes are grantable by this credential (it can grant: ${[...allowed].join(', ') || 'nothing'})`,
      );
    }

    const active = await this.store.activeCount(auth.companyId);
    if (active >= MAX_ACTIVE_KEYS_PER_TENANT) {
      throw new BadRequestException(
        `Tenant already holds ${active} active keys (max ${MAX_ACTIVE_KEYS_PER_TENANT}). Revoke one first.`,
      );
    }

    const input: Parameters<ApiKeyStoreService['issue']>[0] = {
      companyId: auth.companyId,
      name: request.name,
      scopes,
    };
    const userId = this.resolveUserBinding(auth, request.userId);
    if (userId !== undefined) input.userId = userId;
    if (request.expiresInDays !== undefined) {
      input.expiresAt = new Date(Date.now() + request.expiresInDays * 86_400_000);
    }
    const createdBy = auth.userId ?? auth.actorId ?? auth.name;
    if (createdBy !== undefined) input.createdBy = createdBy;

    return this.store.issue(input);
  }

  /** Keys this caller is allowed to see: the tenant's, or just its own. */
  async list(auth: ApiKeyRecord): Promise<ApiKeySummary[]> {
    const keys = await this.store.list(auth.companyId);
    return keys.filter((key) => this.visibleTo(auth, key));
  }

  async revoke(auth: ApiKeyRecord, id: string): Promise<boolean> {
    this.requireStore();
    if (!this.isTenantOperator(auth)) {
      // A user-bound caller may only revoke a key it can see; checking
      // visibility first keeps "not yours" and "does not exist"
      // indistinguishable from the outside.
      const keys = await this.list(auth);
      if (!keys.some((key) => key.id === id)) return false;
    }
    return this.store.revoke(auth.companyId, id);
  }

  /**
   * `brain:admin` is tenant-operator authority; a caller with no userId
   * at all is acting AS the tenant (M2M / static key), which is the same
   * thing for visibility purposes.
   */
  private isTenantOperator(auth: ApiKeyRecord): boolean {
    return auth.scopes.includes('brain:admin') || auth.userId === undefined;
  }

  private visibleTo(auth: ApiKeyRecord, key: ApiKeySummary): boolean {
    if (this.isTenantOperator(auth)) return true;
    return key.userId !== undefined && key.userId === auth.userId;
  }

  private resolveUserBinding(auth: ApiKeyRecord, requested?: string): string | undefined {
    if (auth.userId === undefined) return requested;
    if (requested !== undefined && requested !== auth.userId && !this.isTenantOperator(auth)) {
      throw new ForbiddenException(
        'Only a brain:admin credential can issue a key for another user',
      );
    }
    return requested ?? auth.userId;
  }

  private requireStore(): void {
    if (!this.store.enabled()) {
      throw new ServiceUnavailableException(
        'Key issuance needs a database-backed key store; this deployment has none',
      );
    }
  }
}
