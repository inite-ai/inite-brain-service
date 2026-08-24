import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiKeyRecord, BrainScope } from './api-key.types';
import { RevocationCacheService } from './revocation-cache.service';
import {
  extractActorId,
  extractEntitlements,
  extractMcpGrantedActions,
  extractPackIds,
  extractPolicyNames,
  extractScopes,
  resolveTokenIdentity,
} from './claim-parsers';

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
  private issuer?: string | undefined;
  private audience?: string;
  private algorithms: string[] = ['RS256'];
  /** Canonical deployment URL — matches RFC 9396 grant `locations`. */
  private publicUrl?: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly revocations: RevocationCacheService,
  ) {}

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
    this.publicUrl = this.configService.get<string>('BRAIN_PUBLIC_URL');
    // Pin the accepted signature algorithms. Without this, jwtVerify accepts
    // ANY alg advertised in the JWKS, which is the classic algorithm-confusion
    // surface (e.g. a symmetric key smuggled into the key set). Configurable
    // for issuers that sign with ES256/EdDSA, but default to RS256.
    this.algorithms = (this.configService.get<string>('AUTH_SERVICE_JWT_ALGS', 'RS256') ?? 'RS256')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    // In production an unvalidated issuer means a token minted by ANY trusted
    // JWKS (e.g. another tenant's auth realm sharing the key infra) would pass.
    // Refuse to boot rather than fail open.
    if (this.configService.get<string>('NODE_ENV') === 'production' && !this.issuer) {
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
        ...(this.issuer !== undefined ? { issuer: this.issuer } : {}),
        ...(this.audience !== undefined ? { audience: this.audience } : {}),
        algorithms: this.algorithms,
      }));
    } catch (e) {
      // Don't log token contents — only the error class/message
      this.logger.debug(`JWT verification failed: ${(e as Error).message}`);
      return null;
    }

    // CAEP deny-list (fed by the SSF receiver): a session/account the
    // auth-service revoked is rejected here even though the signature
    // is still cryptographically valid until exp.
    if (typeof payload.sub === 'string' && this.revocations.isDenied(payload.sub)) {
      this.logger.debug('JWT rejected: subject is deny-listed (CAEP revocation)');
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
    const actorId = extractActorId(payload);
    // RFC 9396 per-tool grants; fail-closed for foreign-location entries
    // (see claim-parsers.ts). undefined = gate inactive.
    const mcpGrantedActions = extractMcpGrantedActions(payload, this.publicUrl);

    return {
      keyHash: `jwt:${payload.jti ?? payload.sub}`,
      companyId: identity.companyId,
      scopes,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(mcpGrantedActions !== undefined ? { mcpGrantedActions } : {}),
      ...(entitlements.length > 0 ? { entitlements } : {}),
      ...(policyNames.length > 0 ? { policyNames } : {}),
      ...(packIds.length > 0 ? { packIds } : {}),
    };
  }
}
