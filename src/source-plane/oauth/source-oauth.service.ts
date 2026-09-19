import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
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
  decryptSecret,
  encryptSecret,
} from '../credential-cipher';
import {
  McpOAuthDiscoveryError,
  discoverMcpAuth,
  registerClient,
  type RegisteredClient,
} from './mcp-oauth-discovery';
import { OAuthCallbackError } from './oauth-errors';
import { OAuthClientRegistryService, type DynamicClient } from './oauth-client-registry.service';
import { signState, verifyState } from './oauth-state';
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
  type OAuthProviderSpec,
} from './oauth-providers';

/** The provider id a grant of a discovered MCP server carries. */
export const MCP_PROVIDER = 'mcp';
const MCP_CLIENT_NAME = 'INITE Brain';

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
  /** The account's own API origin the provider named (`spec.apiBaseKey`) — not a secret, kept with the set. */
  apiBase?: string | undefined;
  /** The identity URL the token response named (`id`, Salesforce). */
  identityUrl?: string | undefined;
}

interface StateRow {
  id: unknown;
  nonce: string;
  provider: string;
  /** The MCP server URL a `mcp` authorization is for. */
  resource?: string | null;
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
  resource?: string | null;
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
 * What one token exchange needs — a static provider with the operator's
 * app (oauth-providers.ts), or a discovered MCP server's authorization
 * server with the client the brain registered there.
 */
interface TokenClient {
  id: string;
  tokenUrl: string;
  tokenAuth?: 'body' | 'basic' | 'none' | undefined;
  clientId: string;
  clientSecret: string;
  private: boolean;
  /** Null = no identity lookup (the account label is the resource's host). */
  identity: OAuthProviderSpec['identity'] | null;
  revoke?: { url: string; style: 'token_param' | 'bearer' } | undefined;
  apiBaseKey?: string | undefined;
  /** Sent with every token request (RFC 8707 `resource`). */
  tokenParams?: Record<string, string> | undefined;
  /** The dev override / private opt-in and the spec's URL for identityUrl(). */
  spec: (OAuthProviderSpec & { private: boolean }) | null;
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

  constructor(
    private readonly surreal: SurrealService,
    private readonly clients: OAuthClientRegistryService,
  ) {}

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
    const scopes = [...new Set([...provider.baseScopes, ...p.scopes])];
    return this.begin(companyId, {
      provider: provider.id,
      resource: null,
      scopes,
      authorizeUrl: provider.authorizeUrl,
      clientId: provider.clientId,
      authorizeParams: provider.authorizeParams,
      redirectUri: p.redirectUri,
      origin: p.origin,
      actor: p.actor,
      userId: p.userId,
    });
  }

  /**
   * Begin against an MCP server (W4.3): discover its authorization
   * server (RFC 9728 → RFC 8414), hold a client there — the one kept
   * for this resource, the operator's, or a fresh dynamic registration
   * (RFC 7591) — and send the admin to consent with PKCE and the
   * `resource` the tokens are bound to (RFC 8707).
   */
  async startMcp(
    companyId: string,
    p: {
      serverUrl: string;
      allowPrivate: boolean;
      client?: { clientId: string; clientSecret?: string | undefined } | undefined;
      redirectUri: string;
      origin?: string | undefined;
      actor: string;
      userId?: string | undefined;
    },
  ): Promise<{ authorizeUrl: string; state: string; expiresAt: string; resource: string }> {
    this.assertReady();
    let discovered;
    try {
      discovered = await discoverMcpAuth(p.serverUrl, { allowPrivate: p.allowPrivate });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const resource = discovered.resource;
    const scopes = discovered.prm?.scopesSupported ?? [];
    let client = p.client ? null : await this.clients.find(companyId, resource);
    if (!client) {
      const registered: RegisteredClient = p.client
        ? {
            clientId: p.client.clientId,
            clientSecret: p.client.clientSecret ?? null,
            tokenAuth: p.client.clientSecret ? 'body' : 'none',
          }
        : await registerClient(
            discovered.as,
            { redirectUri: p.redirectUri, clientName: MCP_CLIENT_NAME, scopes },
            { allowPrivate: p.allowPrivate },
          ).catch((e: Error) => {
            throw e instanceof McpOAuthDiscoveryError ? new BadRequestException(e.message) : e;
          });
      client = await this.clients.put(companyId, {
        resource,
        as: discovered.as,
        client: registered,
        registration: p.client ? 'operator' : 'dynamic',
        scopes,
        allowPrivate: p.allowPrivate,
      });
      this.logger.log(
        `oauth client for ${resource} (${p.client ? 'operator' : 'dynamic'} registration at ${discovered.as.issuer}) for ${companyId}`,
      );
    }
    const begun = await this.begin(companyId, {
      provider: MCP_PROVIDER,
      resource,
      scopes: client.scopes,
      authorizeUrl: client.authorizationEndpoint,
      clientId: client.clientId,
      authorizeParams: { resource },
      redirectUri: p.redirectUri,
      origin: p.origin,
      actor: p.actor,
      userId: p.userId,
    });
    return { ...begun, resource };
  }

  /** The state row and the consent URL — PKCE (S256), the signed state, the provider's own parameters. */
  private async begin(
    companyId: string,
    p: {
      provider: string;
      resource: string | null;
      scopes: string[];
      authorizeUrl: string;
      clientId: string;
      authorizeParams: Record<string, string>;
      redirectUri: string;
      origin?: string | undefined;
      actor: string;
      userId?: string | undefined;
    },
  ): Promise<{ authorizeUrl: string; state: string; expiresAt: string }> {
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    const state = signState(companyId, nonce);
    await this.surreal.withCompany(companyId, (db) =>
      db.query(`CREATE source_oauth_state CONTENT $content`, {
        content: {
          nonce,
          provider: p.provider,
          ...(p.resource ? { resource: p.resource } : {}),
          scopes: p.scopes,
          codeVerifier: encryptSecret(verifier),
          redirectUri: p.redirectUri,
          ...(p.origin ? { origin: p.origin } : {}),
          actor: p.actor,
          ...(p.userId ? { userId: p.userId } : {}),
          expiresAt,
        },
      }),
    );
    const url = new URL(p.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', p.clientId);
    url.searchParams.set('redirect_uri', p.redirectUri);
    if (p.scopes.length > 0) url.searchParams.set('scope', p.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(p.authorizeParams)) url.searchParams.set(k, v);
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
    let provider: TokenClient;
    try {
      provider = await this.clientFor(companyId, row);
    } catch (e) {
      throw new OAuthCallbackError((e as Error).message, origin);
    }
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
    const account = await this.identity(provider, tokens);
    const grantId = await this.surreal.withCompany(companyId, async (db) => {
      const [created] = await queryRows<{ id: unknown }>(
        db,
        `CREATE source_oauth_grant CONTENT $content`,
        {
          content: {
            provider: provider.id,
            ...(row.resource ? { resource: row.resource } : {}),
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
    const provider = await this.clientFor(companyId, row).catch(() => null);
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
    const provider = await this.clientFor(companyId, row);
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
    // A provider that does not rotate refresh tokens omits it: keep ours;
    // the same for the account's API origin and identity URL.
    const merged: TokenSet = {
      ...fresh,
      refreshToken: fresh.refreshToken ?? tokens.refreshToken,
      ...((fresh.apiBase ?? tokens.apiBase) ? { apiBase: fresh.apiBase ?? tokens.apiBase } : {}),
      ...((fresh.identityUrl ?? tokens.identityUrl)
        ? { identityUrl: fresh.identityUrl ?? tokens.identityUrl }
        : {}),
    };
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

  /**
   * The token client for a state or grant row: the static provider with
   * the operator's app, or — for `mcp` — the client the brain holds at
   * the resource's authorization server. Throws by name when neither.
   */
  private async clientFor(
    companyId: string,
    row: { provider: string; resource?: string | null | undefined },
  ): Promise<TokenClient> {
    if (row.provider === MCP_PROVIDER) {
      if (!row.resource) throw new Error('the mcp grant names no resource');
      const client = await this.clients.find(companyId, row.resource);
      if (!client) throw new Error(`no oauth client registered for ${row.resource}`);
      return mcpTokenClient(client);
    }
    if (!isOAuthProviderId(row.provider)) throw new Error(`unknown provider ${row.provider}`);
    const provider = resolveProvider(row.provider);
    if (!provider) throw new Error(`provider ${row.provider} is no longer configured`);
    return { ...provider, spec: provider };
  }

  /** One POST to the token endpoint; the client authenticates as the provider takes it (body / basic / none). */
  private async exchange(provider: TokenClient, params: Record<string, string>): Promise<TokenSet> {
    const basic = provider.tokenAuth === 'basic';
    const body = new URLSearchParams({
      ...params,
      ...(provider.tokenParams ?? {}),
      ...(basic
        ? {}
        : {
            client_id: provider.clientId,
            ...(provider.clientSecret && provider.tokenAuth !== 'none'
              ? { client_secret: provider.clientSecret }
              : {}),
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
      ...apiBaseOf(provider, json),
      ...identityUrlOf(provider, json),
    };
  }

  /** The account label — never fatal: a grant without a name is still a grant; an MCP grant is labelled by its server. */
  private async identity(provider: TokenClient, tokens: TokenSet): Promise<string | null> {
    if (!provider.identity || !provider.spec) {
      return provider.tokenParams?.resource ? new URL(provider.tokenParams.resource).host : null;
    }
    const accessToken = tokens.accessToken;
    try {
      const res = await safeFetch(identityUrl(provider.spec, accessToken, tokens.identityUrl), {
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

  private async revokeAtProvider(provider: TokenClient, tokens: TokenSet): Promise<boolean> {
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
    resource: r.resource ?? null,
    apiBase: tokens?.apiBase ?? (r.resource ? new URL(r.resource).origin : null),
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
  };
}

/** A discovered MCP server's client as a token client: PKCE public by default, `resource` on every token request, revocation when the server lists it. */
function mcpTokenClient(c: DynamicClient): TokenClient {
  return {
    id: MCP_PROVIDER,
    tokenUrl: c.tokenEndpoint,
    tokenAuth: c.tokenAuth,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    private: c.allowPrivate,
    identity: null,
    ...(c.revocationEndpoint
      ? { revoke: { url: c.revocationEndpoint, style: 'token_param' as const } }
      : {}),
    tokenParams: { resource: c.resource },
    spec: null,
  };
}

/** The identity URL the token response named (`id`) — https only, unless the dev override is in force (it reroutes the host anyway). */
function identityUrlOf(
  provider: TokenClient,
  json: Record<string, unknown>,
): { identityUrl?: string } {
  if (typeof json.id !== 'string') return {};
  const ok = provider.private ? /^https?:\/\//i.test(json.id) : /^https:\/\//i.test(json.id);
  return ok ? { identityUrl: json.id } : {};
}

/** The account's API origin the token response named — an https origin only, never a path a provider could smuggle. */
function apiBaseOf(provider: TokenClient, json: Record<string, unknown>): { apiBase?: string } {
  if (!provider.apiBaseKey) return {};
  const raw = json[provider.apiBaseKey];
  if (typeof raw !== 'string') return {};
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !provider.private) return {};
    return { apiBase: u.origin };
  } catch {
    return {};
  }
}

export { signState, verifyState } from './oauth-state';
