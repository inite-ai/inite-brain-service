/**
 * RFC 7662 introspection client — resolves opaque auth-service API keys
 * ("ik_…", issued via the auth admin panel) into ApiKeyRecords.
 *
 * Fulfils the 0.2.0 plan from api-key.service.ts: verticals stop baking
 * static key tables into env and look credentials up at the IdP instead.
 * The introspection answer uses the same claim shape as JWTs
 * (sub/org/org_id/scope/aud), so the tenant/user mapping matches the
 * JWKS path: org → companyId, sub → userId (unless sub IS the org).
 *
 * Deliberately a plain class, not a Nest provider: CredentialResolver
 * constructs it from config, keeping its DI constructor within the
 * 3-param gate. Answers are cached briefly so an MCP burst doesn't turn
 * into an introspection-endpoint burst (auth throttles at 60/min).
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ApiKeyRecord, BrainScope } from './api-key.types';
import { extractPolicyNames } from './claim-parsers';

/**
 * Scopes an introspected (operator-issued) key may carry. Superset of the
 * JWT set: indexer:write / registry:publish / registry:curate are
 * meaningful ONLY as long-lived integration keys — exactly what
 * auth-service API keys are — while user JWTs must never smuggle them.
 * (registry:curate was briefly "env-key-only", but production disables
 * the static key table entirely, which made curation unreachable —
 * introspected keys ARE the operator-issued surface now.)
 */
const INTROSPECTED_SCOPES: ReadonlySet<BrainScope> = new Set([
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
  'registry:publish',
  'registry:curate',
  'indexer:write',
]);

const VALID_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SCOPES = 64;
/** Positive answers are safe to reuse briefly; revocation lag ≤ this. */
const POSITIVE_TTL_MS = 60_000;
/** Negative answers retry sooner — a just-issued key must not be bricked. */
const NEGATIVE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 1000;

interface CacheEntry {
  expiresAt: number;
  record: ApiKeyRecord | null;
}

export class IntrospectionClient {
  private readonly logger = new Logger(IntrospectionClient.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly opts: {
      url: string;
      clientId: string;
      clientSecret: string;
      audience: string;
    },
  ) {}

  /**
   * Build from env, or null when not configured (dev without auth-service).
   * Requires AUTH_SERVICE_URL (or the explicit *_INTROSPECTION_URL
   * override) plus the brain-service M2M client credentials.
   */
  static fromConfig(config: ConfigService): IntrospectionClient | null {
    const base = config.get<string>('AUTH_SERVICE_URL');
    const url =
      config.get<string>('AUTH_SERVICE_INTROSPECTION_URL') ??
      (base ? `${base.replace(/\/$/, '')}/v1/oauth/introspect` : undefined);
    const clientId = config.get<string>('AUTH_SERVICE_INTROSPECTION_CLIENT_ID');
    const clientSecret = config.get<string>('AUTH_SERVICE_INTROSPECTION_CLIENT_SECRET');
    if (!url || !clientId || !clientSecret) return null;
    const audience = config.get<string>('AUTH_SERVICE_AUDIENCE', 'brain') ?? 'brain';
    return new IntrospectionClient({ url, clientId, clientSecret, audience });
  }

  /** Resolve an opaque key, or null when inactive/foreign/unreachable. */
  async resolve(token: string): Promise<ApiKeyRecord | null> {
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.record;

    const record = await this.introspect(token, cacheKey);
    this.remember(cacheKey, record);
    return record;
  }

  private async introspect(token: string, tokenHash: string): Promise<ApiKeyRecord | null> {
    let payload: Record<string, unknown>;
    try {
      const res = await fetch(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token,
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Introspection endpoint answered ${res.status}`);
        return null;
      }
      payload = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      this.logger.warn(`Introspection request failed: ${(e as Error).message}`);
      return null;
    }
    return mapIntrospectionRecord(payload, tokenHash, this.opts.audience);
  }

  private remember(cacheKey: string, record: ApiKeyRecord | null): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, {
      record,
      expiresAt: Date.now() + (record ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
  }
}

/**
 * Introspection payload → ApiKeyRecord. Enforces `active`, audience
 * binding (a key minted for another vertical never passes), the tenant
 * charset, and the introspected scope allow-list.
 */
export function mapIntrospectionRecord(
  payload: Record<string, unknown>,
  tokenHash: string,
  audience: string,
): ApiKeyRecord | null {
  if (payload.active !== true) return null;
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
  if (!audOk) return null;

  const org = typeof payload.org === 'string' ? payload.org : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  const companyId = org ?? sub;
  if (!companyId || !VALID_COMPANY_ID.test(companyId)) return null;

  const scopeStr = typeof payload.scope === 'string' ? payload.scope : '';
  const scopes = scopeStr
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SCOPES)
    .filter((s): s is BrainScope => INTROSPECTED_SCOPES.has(s as BrainScope));
  if (scopes.length === 0) return null;

  const userId = sub && sub !== companyId ? sub : undefined;
  // Same `policy` member the JWT path parses — auth ApiKey.policyNames.
  const policyNames = extractPolicyNames(payload);
  return {
    keyHash: `introspect:${tokenHash}`,
    companyId,
    scopes,
    ...(userId ? { userId } : {}),
    ...(policyNames.length > 0 ? { policyNames } : {}),
  };
}
