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
  private expectedKids: ReadonlySet<string> = new Set();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('AUTH_SERVICE_JWKS_URL');
    if (!url) {
      this.logger.warn(
        'AUTH_SERVICE_JWKS_URL not set — JWT verification disabled, static keys only',
      );
      return;
    }
    // cacheMaxAge defaults to 30s in jose, but a stale key during
    // rotation lets a compromised key live longer than the M2M JWT
    // TTL. Pin via JWKS_CACHE_MAX_AGE_MS (default 5min to match
    // auth-service M2M token TTL).
    const cacheMaxAge = parseInt(
      this.configService.get<string>('JWKS_CACHE_MAX_AGE_MS', '300000'),
      10,
    );
    this.jwks = createRemoteJWKSet(new URL(url), { cacheMaxAge });
    this.issuer = this.configService.get<string>('AUTH_SERVICE_ISSUER');
    this.audience = this.configService.get<string>('AUTH_SERVICE_AUDIENCE', 'brain');
    // Optional kid allow-list. When set, JWTs signed with an
    // unknown kid (e.g. an attacker who registered a rogue key
    // anywhere reachable) are rejected even if the signature
    // verifies. Empty allow-list = trust any kid the JWKS endpoint
    // serves (matches pre-hardening behaviour).
    const kidEnv = this.configService.get<string>('JWKS_EXPECTED_KIDS', '');
    this.expectedKids = new Set(
      kidEnv.split(',').map((k) => k.trim()).filter(Boolean),
    );
    const kidNote =
      this.expectedKids.size > 0
        ? `expectedKids=[${[...this.expectedKids].join(',')}]`
        : 'expectedKids=any';
    this.logger.log(
      `JWKS verifier enabled — url=${url}, audience=${this.audience}, ` +
        `cacheMaxAge=${cacheMaxAge}ms, ${kidNote}`,
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
    let protectedHeader: { kid?: string; alg?: string };
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      payload = result.payload;
      protectedHeader = result.protectedHeader as {
        kid?: string;
        alg?: string;
      };
    } catch (e) {
      // Don't log token contents — only the error class/message
      this.logger.debug(`JWT verification failed: ${(e as Error).message}`);
      return null;
    }

    // Kid allow-list — when configured, reject signatures from
    // keys not on the list even if the JWKS endpoint serves them.
    // Defends against scenarios where the auth-service domain is
    // compromised and starts publishing rogue keys.
    if (this.expectedKids.size > 0) {
      const kid = protectedHeader?.kid;
      if (!kid || !this.expectedKids.has(kid)) {
        this.logger.debug(
          `JWT rejected — kid=${kid ?? 'none'} not in expected set`,
        );
        return null;
      }
    }

    const companyId = typeof payload.sub === 'string' ? payload.sub : null;
    if (!companyId) return null;

    const scopes = extractScopes(payload).filter((s): s is BrainScope =>
      VALID_SCOPES.has(s as BrainScope),
    );
    if (scopes.length === 0) return null;

    return {
      keyHash: `jwt:${payload.jti ?? payload.sub}`,
      companyId,
      scopes,
    };
  }
}

function extractScopes(payload: JWTPayload): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((s): s is string => typeof s === 'string');
  }
  if (typeof payload.scope === 'string') {
    return payload.scope.split(' ').filter(Boolean);
  }
  return [];
}
