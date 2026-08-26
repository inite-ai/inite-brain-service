import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ApiKeyRecord } from './api-key.types';
import { TenantRegistryService } from './tenant-registry.service';

/**
 * In-memory ApiKey registry, sourced from BRAIN_API_KEYS env var (JSON).
 *
 * Dev/bootstrap fallback only. Production credentials come from the
 * auth-service: JWTs verified via JWKS (JwksService) and long-lived
 * opaque ik_… keys resolved via RFC 7662 introspection
 * (IntrospectionClient); CredentialResolverService disables this static
 * table in production whenever a remote verifier is configured.
 */
@Injectable()
export class ApiKeyService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyService.name);
  private byHash = new Map<string, ApiKeyRecord>();

  constructor(
    private readonly configService: ConfigService,
    // Optional so unit-test fixtures can construct ApiKeyService with just
    // ConfigService: absent → knownCompanyIds() computes from byHash exactly
    // as before (byte-identical). Present → the roster is registry-backed.
    @Optional() private readonly tenantRegistry?: TenantRegistryService,
  ) {}

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
        throw new Error(
          'BRAIN_API_KEYS entry missing required fields (keyHash, companyId, scopes)',
        );
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
      // `policies` is a legacy field name the typed ApiKey no longer carries
      // (it has `policyNames`); read it through a narrow local shape.
      const legacy = k as { policies?: unknown };
      if (k.policyNames !== undefined || legacy.policies !== undefined) {
        const names = legacy.policies ?? k.policyNames;
        if (!Array.isArray(names) || names.some((n: unknown) => typeof n !== 'string')) {
          throw new Error(
            `BRAIN_API_KEYS entry has malformed policies (expected array of strings): companyId=${k.companyId}`,
          );
        }
        k.policyNames = names;
        delete legacy.policies;
      }
      // Optional per-pack indexer binding: `"packIds": ["my_pack", …]`.
      // Same malformed-is-a-boot-error stance as policies — an operator
      // who typed `"packIds": "my_pack"` believes the key is fenced.
      if (k.packIds !== undefined) {
        if (
          !Array.isArray(k.packIds) ||
          k.packIds.length === 0 ||
          k.packIds.some((p: unknown) => typeof p !== 'string' || !p)
        ) {
          throw new Error(
            `BRAIN_API_KEYS entry has malformed packIds (expected non-empty array of strings): companyId=${k.companyId}`,
          );
        }
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
   * Distinct companyIds the platform knows about — the roster every
   * background fan-out (compaction, retention, dreams, calibration, reindex,
   * changefeed drain, subscriptions) and the platform-operator cross-tenant
   * scope enumerate through.
   *
   * The static BRAIN_API_KEYS set (byHash) is the dev/bootstrap seed and the
   * fallback; the DB-backed tenant_registry (TenantRegistryService, R4) is
   * the production source that fills as tenants authenticate/provision. We
   * UNION the two, static-first, so:
   *   - registry EMPTY (dev, single-tenant, bootstrap, or a remote verifier
   *     that hasn't seen its first request yet) ⇒ return the static set
   *     unchanged — byte-identical to pre-R4 behaviour, including order.
   *   - static EMPTY (prod-JWKS, BRAIN_API_KEYS unset) ⇒ return the
   *     registry roster, which is the whole point: fan-out is no longer [].
   *   - both present (dev with registered tenants) ⇒ the deduped union;
   *     where the registry only mirrors static keys the result equals the
   *     static set byte-for-byte.
   * knownCompanyIds() stays SYNCHRONOUS: the registry read is served from
   * TenantRegistryService's in-memory cache, so no fan-out caller changes.
   */
  knownCompanyIds(): string[] {
    const staticIds = [...new Set([...this.byHash.values()].map((r) => r.companyId))];
    const registryIds = this.tenantRegistry?.activeCompanyIds() ?? [];
    if (registryIds.length === 0) return staticIds; // fallback: byte-identical
    return [...new Set([...staticIds, ...registryIds])];
  }

  /**
   * Registration hook for the credential path (R4): a bearer token just
   * resolved to this tenant, so it is live — record it in the production
   * roster. Delegates to the registry (synchronous cache-add + throttled
   * fire-and-forget write; never throws). No-op when the registry is not
   * wired (dev / unit tests), where the static set already covers the
   * roster. Kept here so CredentialResolverService needs no extra injected
   * dependency (its DI list is capped at 3).
   */
  noteResolvedTenant(companyId: string): void {
    this.tenantRegistry?.touch(companyId);
  }

  /**
   * Static keys registered for one tenant — the admin keys surface
   * (GET /v1/admin/keys). Records carry hashes only, never plaintext.
   */
  listForCompany(companyId: string): ApiKeyRecord[] {
    return [...this.byHash.values()].filter((r) => r.companyId === companyId);
  }
}
