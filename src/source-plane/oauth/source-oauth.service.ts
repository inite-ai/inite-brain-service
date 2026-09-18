import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sourceOAuthClientEnabled } from '../../common/source-plane-flags';
import type {
  SourceOAuthGrant,
  SourceOAuthProviderState,
} from '../../contracts/source-plane/source-plane.schema';
import { SurrealService, queryFirst, queryRows } from '../../db/surreal.service';
import { idTailOf } from '../../ingest/ingest-utils';
import { safeFetch } from '../connectors/safe-fetch';
import {
  CredentialCipherError,
  credentialCipherReady,
  credentialKeys,
  decryptSecret,
  encryptSecret,
} from '../credential-cipher';
import { OAuthCallbackError } from './oauth-errors';
import {
  OAUTH_PROVIDER_IDS,
  identityUrl,
  isOAuthProviderId,
  pickAccount,
  providerClientIdEnv,
  providerConfigured,
  providerSpec,
  resolveProvider,
  type OAuthProviderId,
  type ResolvedProvider,
} from './oauth-providers';

/** How long a started authorization may take before its state is dead. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh when the access token has less than this left. */
const REFRESH_SKEW_MS = 90 * 1000;
const TOKEN_TIMEOUT_MS = 15_000;

/** The token set a grant keeps — one encrypted JSON string at rest. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  /** ISO 8601; absent = the provider did not say. */
  expiresAt?: string | undefined;
  tokenType: string;
  scope?: string | undefined;
}

interface StateRow {
  id: unknown;
  nonce: string;
  provider: string;
  scopes: string[];
  codeVerifier: string;
  redirectUri: string;
  origin?: string | null;
  actor: string;
  userId?: string | null;
  expiresAt: unknown;
}

interface GrantRow {
  id: unknown;
  provider: string;
  account?: string | null;
  scopes?: string[];
  tokens: string;
  status: 'active' | 'revoked' | 'broken';
  actor: string;
  userId?: string | null;
  lastRefreshAt?: unknown;
  lastError?: string | null;
  createdAt: unknown;
}

/**
 * SourceOAuthService — the brain as an OUTBOUND OAuth 2.1 client
 * (raw-evidence-sources-2026-09.md W4). Authorization code + PKCE (S256)
 * against a platform provider; the resulting token set is a GRANT the
 * tenant owns, encrypted at rest (SOURCE_CREDENTIAL_ENCRYPTION_KEY — required: the
 * client refuses to start without it, a refresh token is never written
 * in the clear). A connection names its grant as `oauth:<id>` and the
 * engine asks `accessToken()` at run time, which refreshes when the
 * token is about to expire (single-flight per grant within a process).
 *
 * The `state` parameter is self-authenticating: `<companyId>.<nonce>`
 * signed with HMAC-SHA256 under the credential key, so the public
 * callback never opens (nor provisions) a tenant for a forged value —
 * the signature fails before any query.
 */
@Injectable()
export class SourceOAuthService {
  private readonly logger = new Logger(SourceOAuthService.name);
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly surreal: SurrealService) {}

  /** SOURCE_OAUTH_CLIENT on AND a credential key set — both, or no grant is ever made. */
  ready(): boolean {
    return sourceOAuthClientEnabled() && credentialCipherReady();
  }

  providers(redirectUri: string): SourceOAuthProviderState[] {
    return OAUTH_PROVIDER_IDS.map((id) => ({
      id,
      title: providerSpec(id).title,
      configured: providerConfigured(id),
      redirectUri,
    }));
  }

  /** Begin: the state row and the provider's consent URL. */
  async start(
    companyId: string,
    p: {
      provider: OAuthProviderId;
      scopes: string[];
      redirectUri: string;
      origin?: string | undefined;
      actor: string;
      userId?: string | undefined;
    },
  ): Promise<{ authorizeUrl: string; state: string; expiresAt: string }> {
    this.assertReady();
    const provider = resolveProvider(p.provider);
    if (!provider) {
      throw new BadRequestException(
        `provider "${p.provider}" is not configured (${providerClientIdEnv(p.provider)})`,
      );
    }
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const scopes = [...new Set([...provider.baseScopes, ...p.scopes])];
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    const state = signState(companyId, nonce);
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`CREATE source_oauth_state CONTENT $content`, {
        content: {
          nonce,
          provider: provider.id,
          scopes,
          codeVerifier: encryptSecret(verifier),
          redirectUri: p.redirectUri,
          ...(p.origin ? { origin: p.origin } : {}),
          actor: p.actor,
          ...(p.userId ? { userId: p.userId } : {}),
          expiresAt,
        },
      }),
    );
    const url = new URL(provider.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', p.redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(provider.authorizeParams)) url.searchParams.set(k, v);
    return { authorizeUrl: url.toString(), state, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The provider's return: verify the state, spend it, exchange the code
   * (with the PKCE verifier), learn who the account is, keep the grant.
   */
  async callback(q: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
  }): Promise<{
    grantId: string;
    provider: string;
    account: string | null;
    origin: string | null;
  }> {
    this.assertReady();
    const parsed = q.state ? verifyState(q.state) : null;
    if (!parsed) throw new OAuthCallbackError('invalid or missing state');
    const { companyId, nonce } = parsed;
    const row = await this.surreal.withCompany(companyId, async (db) => {
      const found = await queryFirst<StateRow>(
        db,
        `SELECT * FROM source_oauth_state WHERE nonce = $nonce LIMIT 1`,
        { nonce },
      );
      if (found) await db.query(`DELETE $id`, { id: found.id });
      return found;
    });
    if (!row) throw new OAuthCallbackError('unknown or already used state');
    const origin = row.origin ?? null;
    if (new Date(row.expiresAt as string).getTime() < Date.now()) {
      throw new OAuthCallbackError('the authorization took too long — start again', origin);
    }
    if (q.error) {
      throw new OAuthCallbackError(
        `${q.error}${q.errorDescription ? `: ${q.errorDescription}` : ''}`,
        origin,
      );
    }
    if (!q.code) throw new OAuthCallbackError('no authorization code in the callback', origin);
    if (!isOAuthProviderId(row.provider)) throw new OAuthCallbackError('unknown provider', origin);
    const provider = resolveProvider(row.provider);
    if (!provider) throw new OAuthCallbackError('provider no longer configured', origin);
    let tokens: TokenSet;
    try {
      tokens = await this.exchange(provider, {
        grant_type: 'authorization_code',
        code: q.code,
        redirect_uri: row.redirectUri,
        code_verifier: decryptSecret(row.codeVerifier),
      });
    } catch (e) {
      throw new OAuthCallbackError(`token exchange failed: ${(e as Error).message}`, origin);
    }
    const account = await this.identity(provider, tokens.accessToken);
    const grantId = await this.surreal.withCompany(companyId, async (db) => {
      const [created] = await queryRows<{ id: unknown }>(
        db,
        `CREATE source_oauth_grant CONTENT $content`,
        {
          content: {
            provider: provider.id,
            ...(account ? { account } : {}),
            scopes: row.scopes,
            tokens: encryptSecret(JSON.stringify(tokens)),
            status: 'active',
            actor: row.actor,
            ...(row.userId ? { userId: row.userId } : {}),
          },
        },
      );
      return String(created?.id);
    });
    this.logger.log(
      `oauth grant ${grantId} (${provider.id}, ${account ?? 'no account'}) for ${companyId}`,
    );
    return { grantId, provider: provider.id, account, origin };
  }

  async list(companyId: string): Promise<SourceOAuthGrant[]> {
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<GrantRow>(db, `SELECT * FROM source_oauth_grant ORDER BY createdAt DESC LIMIT 200`),
    );
    return rows.map((r) => toGrant(r, this.tokensOf(r)));
  }

  async get(companyId: string, grantId: string): Promise<SourceOAuthGrant> {
    const row = await this.loadRow(companyId, grantId);
    return toGrant(row, this.tokensOf(row));
  }

  /**
   * A fresh access token for a grant — the engine's read. Refreshes when
   * the token is within the skew of expiring; a refresh the provider
   * refuses marks the grant broken (the admin reconnects the account).
   */
  async accessToken(companyId: string, grantId: string): Promise<string> {
    const key = `${companyId}/${grantId}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.resolveToken(companyId, grantId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** Disconnect: best-effort revocation at the provider, then the row is `revoked`. */
  async revoke(
    companyId: string,
    grantId: string,
  ): Promise<{ revoked: boolean; providerRevoked: boolean }> {
    const row = await this.loadRow(companyId, grantId);
    let providerRevoked = false;
    const provider = isOAuthProviderId(row.provider) ? resolveProvider(row.provider) : null;
    const tokens = this.tokensOf(row);
    // Best effort for a broken grant too: its refresh token may still be alive at the provider.
    if (provider?.revoke && tokens && row.status !== 'revoked') {
      providerRevoked = await this.revokeAtProvider(provider, tokens);
    }
    await this.surreal.withCompany(companyId, (db) =>
      db.query(
        `UPDATE $id SET status = 'revoked', tokens = $tokens, updatedAt = $now, lastError = NONE`,
        { id: row.id, tokens: encryptSecret('{}'), now: new Date() },
      ),
    );
    return { revoked: true, providerRevoked };
  }

  private async resolveToken(companyId: string, grantId: string): Promise<string> {
    const row = await this.loadRow(companyId, grantId);
    if (row.status !== 'active') {
      throw new Error(`connected account ${grantId} is ${row.status} — reconnect it`);
    }
    const tokens = this.tokensOf(row);
    if (!tokens) throw new Error(`connected account ${grantId} has no tokens`);
    const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : null;
    if (expiresAt === null || expiresAt - Date.now() > REFRESH_SKEW_MS) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await this.markBroken(
        companyId,
        row,
        'access token expired and no refresh token was granted',
      );
      throw new Error(
        `connected account ${grantId} expired without a refresh token — reconnect it`,
      );
    }
    if (!isOAuthProviderId(row.provider)) throw new Error(`unknown provider ${row.provider}`);
    const provider = resolveProvider(row.provider);
    if (!provider) throw new Error(`provider ${row.provider} is no longer configured`);
    let fresh: TokenSet;
    try {
      fresh = await this.exchange(provider, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      });
    } catch (e) {
      const message = (e as Error).message;
      await this.markBroken(companyId, row, `refresh failed: ${message}`);
      throw new Error(`connected account ${grantId}: refresh failed (${message}) — reconnect it`);
    }
    // A provider that does not rotate refresh tokens omits it: keep ours.
    const merged: TokenSet = { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
    await this.surreal.withCompany(companyId, (db) =>
      db.query(
        `UPDATE $id SET tokens = $tokens, lastRefreshAt = $now, updatedAt = $now, lastError = NONE`,
        { id: row.id, tokens: encryptSecret(JSON.stringify(merged)), now: new Date() },
      ),
    );
    return merged.accessToken;
  }

  private async markBroken(companyId: string, row: GrantRow, error: string): Promise<void> {
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`UPDATE $id SET status = 'broken', lastError = $error, updatedAt = $now`, {
        id: row.id,
        error: error.slice(0, 500),
        now: new Date(),
      }),
    );
  }

  private async loadRow(companyId: string, grantId: string): Promise<GrantRow> {
    const row = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<GrantRow>(db, `SELECT * FROM type::record('source_oauth_grant', $tail) LIMIT 1`, {
        tail: idTailOf(grantId),
      }),
    );
    if (!row) throw new NotFoundException(`no connected account ${grantId}`);
    return row;
  }

  private tokensOf(row: GrantRow): TokenSet | null {
    try {
      const parsed = JSON.parse(decryptSecret(row.tokens)) as Partial<TokenSet>;
      return typeof parsed.accessToken === 'string' ? (parsed as TokenSet) : null;
    } catch (e) {
      if (e instanceof CredentialCipherError)
        this.logger.warn(`grant ${String(row.id)}: ${e.message}`);
      return null;
    }
  }

  /** One POST to the token endpoint; the client authenticates in the body (every provider here accepts it). */
  private async exchange(
    provider: ResolvedProvider,
    params: Record<string, string>,
  ): Promise<TokenSet> {
    const basic = provider.tokenAuth === 'basic';
    const body = new URLSearchParams({
      ...params,
      ...(basic
        ? {}
        : {
            client_id: provider.clientId,
            ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}),
          }),
    });
    const res = await safeFetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...(basic
          ? {
              authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`,
            }
          : {}),
      },
      body: body.toString(),
      allowPrivate: provider.private,
      timeoutMs: TOKEN_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`token endpoint answered ${res.status} with a non-JSON body`);
    }
    if (res.status !== 200 || typeof json.access_token !== 'string') {
      const err = typeof json.error === 'string' ? json.error : `http ${res.status}`;
      const desc = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
      throw new Error(`${err}${desc}`);
    }
    const expiresIn =
      typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in);
    return {
      accessToken: json.access_token,
      ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
        : {}),
      tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
    };
  }

  /** The account label — never fatal: a grant without a name is still a grant. */
  private async identity(provider: ResolvedProvider, accessToken: string): Promise<string | null> {
    try {
      const res = await safeFetch(identityUrl(provider, accessToken), {
        method: provider.identity.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(provider.identity.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(provider.identity.method === 'POST' ? { body: 'null' } : {}),
        allowPrivate: provider.private,
        timeoutMs: TOKEN_TIMEOUT_MS,
        maxBytes: 64 * 1024,
      });
      if (res.status !== 200) return null;
      return pickAccount(JSON.parse(res.body.toString('utf8')), provider.identity.pick);
    } catch (e) {
      this.logger.warn(`identity lookup at ${provider.id} failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async revokeAtProvider(provider: ResolvedProvider, tokens: TokenSet): Promise<boolean> {
    const r = provider.revoke;
    if (!r) return false;
    try {
      const token = tokens.refreshToken ?? tokens.accessToken;
      const res =
        r.style === 'token_param'
          ? await safeFetch(r.url, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token }).toString(),
              allowPrivate: provider.private,
              timeoutMs: TOKEN_TIMEOUT_MS,
              maxBytes: 16 * 1024,
            })
          : await safeFetch(r.url, {
              method: 'POST',
              headers: { authorization: `Bearer ${tokens.accessToken}` },
              body: '',
              allowPrivate: provider.private,
              timeoutMs: TOKEN_TIMEOUT_MS,
              maxBytes: 16 * 1024,
            });
      return res.status >= 200 && res.status < 300;
    } catch (e) {
      this.logger.warn(`revoke at ${provider.id} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private assertReady(): void {
    if (!sourceOAuthClientEnabled()) {
      throw new NotFoundException();
    }
    if (!credentialCipherReady()) {
      throw new BadRequestException(
        'SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset — a connected account keeps a refresh token, which is never stored in the clear',
      );
    }
  }
}

// ── state token ──────────────────────────────────────────────────────

const STATE_SIG_BYTES = 16;

function stateKey(): Buffer {
  const [key] = credentialKeys();
  if (!key) throw new CredentialCipherError('SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset');
  return createHash('sha256').update('source-oauth-state').update(key).digest();
}

/** `<companyId>.<nonce>.<sig>` — base64url; the signature binds the tenant so a forged state opens nothing. */
export function signState(companyId: string, nonce: string): string {
  const sig = createHmac('sha256', stateKey())
    .update(`${companyId}.${nonce}`)
    .digest()
    .subarray(0, STATE_SIG_BYTES)
    .toString('base64url');
  return Buffer.from(`${companyId}.${nonce}.${sig}`, 'utf8').toString('base64url');
}

export function verifyState(state: string): { companyId: string; nonce: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Canonical form only: base64url decodes a dangling character leniently,
  // and a non-canonical spelling of a valid state must not spend it.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== state) return null;
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [companyId, nonce, sig] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(companyId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return null;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', stateKey())
      .update(`${companyId}.${nonce}`)
      .digest()
      .subarray(0, STATE_SIG_BYTES);
  } catch {
    return null;
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return null;
  return { companyId, nonce };
}

function toGrant(r: GrantRow, tokens: TokenSet | null): SourceOAuthGrant {
  const iso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    id: String(r.id),
    provider: r.provider,
    account: r.account ?? null,
    scopes: Array.isArray(r.scopes) ? r.scopes.map(String) : [],
    status: r.status,
    actor: r.actor,
    ownerUserId: r.userId ?? null,
    accessExpiresAt: tokens?.expiresAt ?? null,
    refreshable: typeof tokens?.refreshToken === 'string',
    lastRefreshAt: iso(r.lastRefreshAt),
    lastError: r.lastError ?? null,
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
  };
}
