import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ApiKeyRecord } from './api-key.types';

/**
 * In-memory ApiKey registry, sourced from BRAIN_API_KEYS env var (JSON).
 *
 * 0.1.0 walking-skeleton: keys are static, declared at boot.
 * 0.2.0+: replace with @inite/auth integration — verticals will issue
 * keys via inite.core.api-key, and this service will lookup via JWKS or
 * an auth-service introspection endpoint.
 */
@Injectable()
export class ApiKeyService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyService.name);
  private byHash = new Map<string, ApiKeyRecord>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const raw = this.configService.get<string>('BRAIN_API_KEYS', '[]');
    let keys: ApiKeyRecord[];
    try {
      keys = JSON.parse(raw);
    } catch (err) {
      throw new Error(`BRAIN_API_KEYS is not valid JSON: ${(err as Error).message}`);
    }
    for (const k of keys) {
      if (!k.keyHash || !k.companyId || !Array.isArray(k.scopes)) {
        throw new Error('BRAIN_API_KEYS entry missing required fields (keyHash, companyId, scopes)');
      }
      // Hash shape MUST match the convention `static hash()` emits —
      // `sha256:` + 64 hex chars. A misconfigured operator entry
      // (e.g. accidentally pasting the plaintext key in keyHash, or a
      // truncated digest) silently never matches at request time and
      // looks identical to a real-but-unknown caller. Fail at boot
      // instead so the misconfiguration surfaces immediately.
      const normalised = k.keyHash.toLowerCase();
      if (!/^sha256:[0-9a-f]{64}$/.test(normalised)) {
        throw new Error(
          `BRAIN_API_KEYS entry has malformed keyHash (expected 'sha256:' + 64 hex chars): companyId=${k.companyId}`,
        );
      }
      // Optional ABAC attachment: `"policies": ["set-name", …]`. A
      // malformed value is a boot error, not a silently ignored field —
      // an operator who typed `"policies": "readonly"` believes the key
      // is restricted.
      if (k.policyNames !== undefined || (k as any).policies !== undefined) {
        const names = (k as any).policies ?? k.policyNames;
        if (
          !Array.isArray(names) ||
          names.some((n: unknown) => typeof n !== 'string')
        ) {
          throw new Error(
            `BRAIN_API_KEYS entry has malformed policies (expected array of strings): companyId=${k.companyId}`,
          );
        }
        k.policyNames = names;
        delete (k as any).policies;
      }
      this.byHash.set(normalised, k);
    }
    this.logger.log(`Loaded ${this.byHash.size} ApiKey(s)`);
  }

  /** Hash a plaintext key the same way operators do when registering. */
  static hash(plaintext: string): string {
    return 'sha256:' + createHash('sha256').update(plaintext).digest('hex');
  }

  resolve(plaintext: string): ApiKeyRecord | null {
    const hash = ApiKeyService.hash(plaintext);
    return this.byHash.get(hash.toLowerCase()) ?? null;
  }

  /**
   * Distinct companyIds that have at least one registered key. Used by
   * background jobs (compaction, retention) that need to fan out across
   * tenants without owning a registry of their own.
   */
  knownCompanyIds(): string[] {
    return [...new Set([...this.byHash.values()].map((r) => r.companyId))];
  }

  /**
   * Static keys registered for one tenant — the admin keys surface
   * (GET /v1/admin/keys). Records carry hashes only, never plaintext.
   */
  listForCompany(companyId: string): ApiKeyRecord[] {
    return [...this.byHash.values()].filter((r) => r.companyId === companyId);
  }
}
