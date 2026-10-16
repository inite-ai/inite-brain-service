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
import { acceptedAudiences, acceptedIssuers, audienceAccepted } from './token-audience';

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
 * verified against that URL's keys. Tenant = `org` (user-bound token,
 * end-user = `sub`) or `sub` (M2M token, no `org`). Scopes come from
 * `scopes` (array) or `scope` (space-delimited string). `iss` and `aud`
 * follow the INITE Triad token contract (see token-audience.ts).
 *
 * In development, leaving JWKS_URL unset disables this verifier and the
 * guard falls back to the static BRAIN_API_KEYS map (sha256 lookup).
 */
@Injectable()
export class JwksService implements OnModuleInit {
  private readonly logger = new Logger(JwksService.name);
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  /** Accepted `iss` values; empty = unvalidated (dev only). */
  private issuers: string[] = [];
  /**
   * Every audience this deployment answers to. More than one, because a
   * token can be addressed at us in more than one way: the vertical name
   * the auth-service stamps by default (`brain`), and — for a client
   * that asked with RFC 8707 `resource=` — the URL it named. An MCP
   * client discovering us through OAuth does exactly the latter, so
   * accepting only the vertical name meant every correctly-issued
   * connector token was rejected.
   */
  private audiences: string[] = [];
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
    this.issuers = acceptedIssuers(this.configService.get<string>('AUTH_SERVICE_ISSUER'));
    this.publicUrl = this.configService.get<string>('BRAIN_PUBLIC_URL');
    this.audiences = acceptedAudiences((key) => this.configService.get<string>(key));
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
    if (this.configService.get<string>('NODE_ENV') === 'production' && this.issuers.length === 0) {
      throw new Error(
        'AUTH_SERVICE_ISSUER must be set in production when JWKS verification ' +
          'is enabled — without it the `iss` claim is not validated and any ' +
          'token signed by the JWKS keys is accepted.',
      );
    }
    this.logger.log(
      `JWKS verifier enabled — url=${url}, audiences=[${this.audiences.join(',')}], ` +
        `issuer=${this.issuers.length > 0 ? this.issuers.join(',') : '(unvalidated)'}, ` +
        `algs=[${this.algorithms.join(',')}]`,
    );
  }

  enabled(): boolean {
    return this.jwks !== null;
  }

  /**
   * The auth-service's revocation signal (CAEP deny-list, fed by the SSF
   * receiver): true when `subject` was revoked. Owned here next to the
   * key material because CredentialResolverService applies it to every
   * source — a signature is not the only thing the auth-service says
   * about a token.
   */
  subjectDenied(subject: string): Promise<boolean> {
    return this.revocations.isDenied(subject);
  }

  /**
   * Verify a Bearer token as a JWT and return an ApiKeyRecord shape if it
   * passes signature, expiry, issuer, and audience checks. Returns null on
   * any verification failure — the guard then falls back to static lookup.
   * The CAEP deny-list is NOT applied here: CredentialResolverService
   * applies it (subjectDenied) once, to every credential source.
   */
  async verify(token: string): Promise<ApiKeyRecord | null> {
    if (!this.jwks) return null;
    let payload: JWTPayload;
    try {
      // `aud` is checked below, once the tenant is known: the per-tenant
      // resource `<url>/mcp/<companyId>` is only valid for its own tenant.
      ({ payload } = await jwtVerify(token, this.jwks, {
        ...(this.issuers.length > 0 ? { issuer: this.issuers } : {}),
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
    if (
      this.audiences.length > 0 &&
      !audienceAccepted(payload.aud, {
        accepted: this.audiences,
        publicUrl: this.publicUrl,
        companyId: identity.companyId,
      })
    ) {
      this.logger.debug('JWT verification failed: unexpected "aud" claim value');
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
