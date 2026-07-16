import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiKeyRecord, BrainScope } from './api-key.types';

const VALID_SCOPES: ReadonlySet<BrainScope> = new Set([
  'brain:read',
  'brain:write',
  'brain:admin',
  'brain:read_pii',
]);

// Tenant slug charset. The companyId becomes the `co_<id>` database name
// and is interpolated into record ids, so it must stay within a safe
// identifier charset (alnum / underscore / hyphen, bounded length).
const VALID_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Defence-in-depth cap. A well-formed token carries a handful of scopes;
// an absurdly long array is malformed/hostile and we refuse to parse it.
const MAX_SCOPES = 64;

/**
 * JWT verification against the @inite/auth-service JWKS endpoint.
 *
 * When AUTH_SERVICE_JWKS_URL is set, Bearer tokens shaped like JWTs are
 * verified against that URL's keys. The token's `sub` claim is the
 * companyId. Scopes come from `scopes` (array) or `scope` (space-delimited
 * string). Issuer and audience are validated when configured.
 *
 * In development, leaving JWKS_URL unset disables this verifier and the
 * guard falls back to the static BRAIN_API_KEYS map (sha256 lookup).
 */
@Injectable()
export class JwksService implements OnModuleInit {
  private readonly logger = new Logger(JwksService.name);
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private issuer?: string;
  private audience?: string;
  private algorithms: string[] = ['RS256'];

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('AUTH_SERVICE_JWKS_URL');
    if (!url) {
      this.logger.warn(
        'AUTH_SERVICE_JWKS_URL not set — JWT verification disabled, static keys only',
      );
      return;
    }
    this.jwks = createRemoteJWKSet(new URL(url));
    this.issuer = this.configService.get<string>('AUTH_SERVICE_ISSUER');
    this.audience = this.configService.get<string>('AUTH_SERVICE_AUDIENCE', 'brain');
    // Pin the accepted signature algorithms. Without this, jwtVerify accepts
    // ANY alg advertised in the JWKS, which is the classic algorithm-confusion
    // surface (e.g. a symmetric key smuggled into the key set). Configurable
    // for issuers that sign with ES256/EdDSA, but default to RS256.
    this.algorithms = (
      this.configService.get<string>('AUTH_SERVICE_JWT_ALGS', 'RS256') ?? 'RS256'
    )
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    // In production an unvalidated issuer means a token minted by ANY trusted
    // JWKS (e.g. another tenant's auth realm sharing the key infra) would pass.
    // Refuse to boot rather than fail open.
    if (
      this.configService.get<string>('NODE_ENV') === 'production' &&
      !this.issuer
    ) {
      throw new Error(
        'AUTH_SERVICE_ISSUER must be set in production when JWKS verification ' +
          'is enabled — without it the `iss` claim is not validated and any ' +
          'token signed by the JWKS keys is accepted.',
      );
    }
    this.logger.log(
      `JWKS verifier enabled — url=${url}, audience=${this.audience}, ` +
        `issuer=${this.issuer ?? '(unvalidated)'}, algs=[${this.algorithms.join(',')}]`,
    );
  }

  enabled(): boolean {
    return this.jwks !== null;
  }

  /**
   * Verify a Bearer token as a JWT and return an ApiKeyRecord shape if it
   * passes signature, expiry, issuer, and audience checks. Returns null on
   * any verification failure — the guard then falls back to static lookup.
   */
  async verify(token: string): Promise<ApiKeyRecord | null> {
    if (!this.jwks) return null;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
      }));
    } catch (e) {
      // Don't log token contents — only the error class/message
      this.logger.debug(`JWT verification failed: ${(e as Error).message}`);
      return null;
    }

    // Tenant/user split (auth-service claim model):
    //   `org` present → user-bound token: tenant = org, end-user = sub
    //   `org` absent  → M2M token: tenant = sub, no end-user
    const identity = resolveTokenIdentity(payload);
    if (!identity) {
      this.logger.debug('JWT rejected: no valid tenant identity in org/sub');
      return null;
    }

    const scopes = extractScopes(payload).filter((s): s is BrainScope =>
      VALID_SCOPES.has(s as BrainScope),
    );
    if (scopes.length === 0) return null;

    const policyNames = extractPolicyNames(payload);
    const packIds = extractPackIds(payload);
    const entitlements = extractEntitlements(payload);

    return {
      keyHash: `jwt:${payload.jti ?? payload.sub}`,
      companyId: identity.companyId,
      scopes,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(entitlements.length > 0 ? { entitlements } : {}),
      ...(policyNames.length > 0 ? { policyNames } : {}),
      ...(packIds.length > 0 ? { packIds } : {}),
    };
  }
}

// Per-user memory rows store userId verbatim (option<string> column, always
// a bound query param — never interpolated), so the charset can be wider
// than companyId: any printable token up to the column cap used across the
// DTOs (200). did:key subjects contain ':' so VALID_COMPANY_ID can't apply.
const MAX_USER_ID_LENGTH = 200;

/**
 * Map token claims to the tenant (companyId) + optional end-user (userId).
 * companyId becomes the `co_<id>` database name and is interpolated into
 * record ids, so it must pass the strict tenant-slug charset — whether it
 * came from `org` (user token) or `sub` (M2M token). Returns null when no
 * valid tenant identity can be derived (guard then treats it as 401).
 */
function resolveTokenIdentity(
  payload: JWTPayload,
): { companyId: string; userId?: string } | null {
  const org = (payload as Record<string, unknown>).org;
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (typeof org === 'string' && org.length > 0) {
    if (!VALID_COMPANY_ID.test(org)) return null;
    if (!sub || sub.length === 0 || sub.length > MAX_USER_ID_LENGTH) return null;
    return { companyId: org, userId: sub };
  }
  if (!sub || !VALID_COMPANY_ID.test(sub)) return null;
  return { companyId: sub };
}

// Entitlement slugs are display/tier hints, not authority — still keep the
// charset bounded so a hostile claim can't smuggle odd bytes into metrics.
const VALID_ENTITLEMENT = /^[a-z][a-z0-9_:-]{1,63}$/;
const MAX_ENTITLEMENTS = 16;

/** `entitlements` claim → plan/tier hints (throttle tiers, feature gates). */
function extractEntitlements(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>).entitlements;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string')
    .filter((e) => VALID_ENTITLEMENT.test(e))
    .slice(0, MAX_ENTITLEMENTS);
}

// Policy set names live in the same identifier charset the CRUD layer
// enforces; anything else in the claim is dropped here rather than
// carried into resolution (where an out-of-charset name would fail
// closed and brick the key on a claim-encoding quirk).
const VALID_POLICY_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_POLICY_NAMES = 8;

/**
 * `policy` claim → ABAC policy set names. Array of strings or a single
 * space-delimited string, capped at MAX_POLICY_NAMES (mirrors the
 * resolver-side MAX_SETS_PER_KEY).
 */
function extractPolicyNames(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>).policy;
  let names: string[] = [];
  if (Array.isArray(raw)) {
    names = raw.filter((n): n is string => typeof n === 'string');
  } else if (typeof raw === 'string') {
    names = raw.split(' ').filter(Boolean);
  }
  return names.filter((n) => VALID_POLICY_NAME.test(n)).slice(0, MAX_POLICY_NAMES);
}

// Pack ids share the manifest's snake_case charset (validate.ts); an
// out-of-charset claim entry is dropped, not carried into fencing.
const VALID_PACK_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_PACK_IDS = 16;

/**
 * `packs` claim → per-pack indexer binding (ApiKeyRecord.packIds).
 * Array of strings or a single space-delimited string.
 */
function extractPackIds(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>).packs;
  let ids: string[] = [];
  if (Array.isArray(raw)) {
    ids = raw.filter((n): n is string => typeof n === 'string');
  } else if (typeof raw === 'string') {
    ids = raw.split(' ').filter(Boolean);
  }
  return ids.filter((n) => VALID_PACK_ID.test(n)).slice(0, MAX_PACK_IDS);
}

function extractScopes(payload: JWTPayload): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes
      .filter((s): s is string => typeof s === 'string')
      .slice(0, MAX_SCOPES);
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(' ').filter(Boolean).slice(0, MAX_SCOPES);
  }
  return [];
}
