import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ApiKeyRecord } from './api-key.types';
import { TenantRegistryService } from './tenant-registry.service';
import { ApiKeyStoreService } from './api-key-store.service';

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
    // Same reason: absent → resolveStored() is a no-op and only the env
    // table answers, which is every unit fixture's world.
    @Optional() private readonly keyStore?: ApiKeyStoreService,
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
   * Keys brain issued itself (system-DB store, migration 0141).
   *
   * Routed through this service rather than injected into
   * CredentialResolverService because that constructor is at its
   * three-dependency ceiling — and because "credentials brain owns"
   * (the env table and the issued store) is one responsibility with two
   * backing stores. Returns null when no store is wired (unit fixtures,
   * a DB-less boot), leaving resolution exactly as it was.
   */
  async resolveStored(plaintext: string): Promise<ApiKeyRecord | null> {
    return (await this.keyStore?.resolve(plaintext)) ?? null;
  }

  /**
   * The VALIDATION roster: every companyId the platform knows about — the
   * static BRAIN_API_KEYS set UNIONED (static-first, deduped) with the
   * registry's active roster. This answers "may an operator target tenant X"
   * (resolvePlatformTenant's `knownTenants` closures): a static key whose
   * tenant has never authenticated is a legitimate operator target, because
   * targeting it is how it gets provisioned. It is NOT the roster for
   * background fan-outs — a sweep over the union provisions `co_<id>` (with
   * the full migration set) for every dormant static key; use fanOutRoster()
   * there. A static tenant the registry knows to be suspended is absent from
   * BOTH rosters. Synchronous: the registry read is served from the cache.
   */
  knownCompanyIds(): string[] {
    const staticIds = this.staticCompanyIds();
    const registryIds = this.tenantRegistry?.activeCompanyIds() ?? [];
    if (registryIds.length === 0) return staticIds; // fallback: byte-identical
    return [...new Set([...staticIds, ...registryIds])];
  }

  /**
   * The FAN-OUT roster: the ONE tenant list every background loop (cron
   * sweeps, the worker poller, the reaper, cross-tenant bookkeeping "host
   * tenant" picks) iterates. Registry-active tenants (status='active') when
   * the registry has any; otherwise — dev, bootstrap, a remote verifier that
   * has not seen its first request — the static BRAIN_API_KEYS set, the same
   * members knownCompanyIds() falls back to. Never the union: a static key
   * whose tenant never authenticated must not be walked, because opening its
   * scope creates and migrates its database. Deduped and SORTED, so `[0]` is
   * the same host tenant on every pod and sweep order is stable. Synchronous.
   */
  fanOutRoster(): string[] {
    const registryIds = this.tenantRegistry?.activeCompanyIds() ?? [];
    const roster = registryIds.length > 0 ? registryIds : this.staticCompanyIds();
    return [...new Set(roster)].sort();
  }

  /**
   * The tenant that hosts a cross-tenant bookkeeping row (a refit or
   * registry-mirror job_run, the operator-wide calibration table): the
   * lexicographically smallest id of the fan-out roster. Deterministic across
   * replicas — the registry cache fills from an unordered read plus
   * request-path touch() inserts, so "first cached" differs per pod, and two
   * pods hosting the same job under different tenants both enqueue it (the
   * dedup index is per tenant database). Undefined when the roster is empty.
   */
  hostTenant(): string | undefined {
    return this.fanOutRoster()[0];
  }

  /**
   * The static BRAIN_API_KEYS tenants minus any the registry KNOWS to be
   * non-active (suspended, provisioning): a key never lifts a recorded
   * lifecycle, in either roster. Only an unknown lifecycle falls back to it.
   */
  private staticCompanyIds(): string[] {
    const ids = [...new Set([...this.byHash.values()].map((r) => r.companyId))];
    return ids.filter((id) => {
      const status = this.tenantRegistry?.statusOf(id);
      return status === undefined || status === 'active';
    });
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
