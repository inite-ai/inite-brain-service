import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { RevocationCacheService } from './revocation-cache.service';

/**
 * OpenID Shared Signals Framework receiver — poll delivery (RFC 8936).
 *
 * Polls the auth-service transmitter for CAEP security events and feeds
 * the revocation deny-list, closing the "revoked token stays valid until
 * exp" window inherent to local JWKS verification. Events acted on:
 * session-revoked, account-disabled, token-claims-change (the
 * auth-service emits the latter on refresh-token-family revocation).
 *
 * Enabled when AUTH_SSF_POLL_URL + the poll client credentials are set;
 * silent no-op otherwise (dev). Each SET is itself a signed JWT and is
 * verified against the same JWKS as access tokens before being trusted.
 */

/** CAEP/RISC event URIs that translate to "deny this subject now". */
const REVOKING_EVENTS = [
  'https://schemas.openid.net/secevent/caep/event-type/session-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/caep/event-type/token-claims-change',
];

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_EVENTS_PER_POLL = 50;

interface SetClaims {
  events?: Record<string, unknown>;
  sub_id?: { sub?: string };
}

@Injectable()
export class SsfReceiverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SsfReceiverService.name);
  private timer: NodeJS.Timeout | null = null;
  private pendingAcks: string[] = [];
  private accessToken: { value: string; expiresAtMs: number } | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private polling = false;

  constructor(
    private readonly config: ConfigService,
    private readonly revocations: RevocationCacheService,
  ) {}

  onModuleInit(): void {
    const pollUrl = this.config.get<string>('AUTH_SSF_POLL_URL');
    const jwksUrl = this.config.get<string>('AUTH_SERVICE_JWKS_URL');
    if (!pollUrl || !jwksUrl || !this.pollCredentials()) {
      this.logger.log('SSF receiver disabled (AUTH_SSF_POLL_URL / credentials unset)');
      return;
    }
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    const interval = Number(
      this.config.get<string>('AUTH_SSF_POLL_INTERVAL_MS') ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.timer = setInterval(() => void this.pollOnce(pollUrl), interval);
    this.timer.unref();
    this.logger.log(`SSF receiver polling ${pollUrl} every ${interval}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll turn: deliver acks, verify + apply new SETs, queue acks. */
  async pollOnce(pollUrl: string): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const token = await this.pollToken();
      const res = await fetch(pollUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ acks: this.pendingAcks, maxEvents: MAX_EVENTS_PER_POLL }),
      });
      if (!res.ok) {
        this.logger.warn(`SSF poll answered ${res.status}`);
        return;
      }
      this.pendingAcks = [];
      const body = (await res.json()) as { sets?: Record<string, string> };
      for (const [jti, setJwt] of Object.entries(body.sets ?? {})) {
        await this.applySet(jti, setJwt);
      }
    } catch (e) {
      this.logger.warn(`SSF poll failed: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Verify one SET and deny-list its subject for revoking event types. */
  async applySet(jti: string, setJwt: string): Promise<void> {
    if (!this.jwks) return;
    try {
      const { payload } = await jwtVerify(setJwt, this.jwks, {
        issuer: this.config.get<string>('AUTH_SERVICE_ISSUER'),
      });
      const claims = payload as SetClaims;
      const subject = claims.sub_id?.sub;
      const revokes = Object.keys(claims.events ?? {}).some((e) =>
        REVOKING_EVENTS.includes(e),
      );
      if (subject && revokes) this.revocations.deny(subject);
      this.pendingAcks.push(jti);
    } catch (e) {
      // A SET we can't verify is acked anyway — redelivering it forever
      // would wedge the stream; the failure is logged for the operator.
      this.logger.warn(`SET ${jti} rejected: ${(e as Error).message}`);
      this.pendingAcks.push(jti);
    }
  }

  private pollCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId =
      this.config.get<string>('AUTH_SSF_CLIENT_ID') ??
      this.config.get<string>('AUTH_SERVICE_INTROSPECTION_CLIENT_ID');
    const clientSecret =
      this.config.get<string>('AUTH_SSF_CLIENT_SECRET') ??
      this.config.get<string>('AUTH_SERVICE_INTROSPECTION_CLIENT_SECRET');
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  /** Mint (and cache) the M2M token the poll endpoint requires. */
  private async pollToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAtMs > Date.now()) {
      return this.accessToken.value;
    }
    const creds = this.pollCredentials();
    if (!creds) throw new Error('SSF poll credentials unset');
    const base = (this.config.get<string>('AUTH_SERVICE_URL') ?? '').replace(/\/$/, '');
    const scope = this.config.get<string>('AUTH_SSF_POLL_SCOPE', 'admin');
    const res = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope,
      }),
    });
    if (!res.ok) throw new Error(`poll token mint failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.accessToken = {
      value: body.access_token,
      expiresAtMs: Date.now() + ((body.expires_in ?? 300) - 30) * 1000,
    };
    return this.accessToken.value;
  }
}
