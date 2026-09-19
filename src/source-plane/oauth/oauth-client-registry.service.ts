import { Injectable } from '@nestjs/common';
import { SurrealService, queryFirst, queryRows } from '../../db/surreal.service';
import { decryptSecret, encryptSecret } from '../credential-cipher';
import type { AuthorizationServerMetadata, RegisteredClient } from './mcp-oauth-discovery';

/**
 * What the deployment learned about an MCP server's authorization
 * server, per tenant and per resource (the server URL as named): the
 * endpoints and the client the brain holds there — registered
 * dynamically (RFC 7591) or pasted by the operator. A grant for that
 * resource refreshes and revokes through this row, the way a static
 * provider's grant goes through the registry in oauth-providers.ts.
 */
export interface OAuthClientRow {
  id: unknown;
  resource: string;
  origin: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string | null;
  revocationEndpoint?: string | null;
  clientId: string;
  clientSecret?: string | null;
  tokenAuth: 'none' | 'body' | 'basic';
  scopes?: string[];
  registration: 'dynamic' | 'operator';
  allowPrivate?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** The client as the token endpoint sees it — the secret in the clear, for one exchange. */
export interface DynamicClient {
  resource: string;
  origin: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  clientSecret: string;
  tokenAuth: 'none' | 'body' | 'basic';
  scopes: string[];
  allowPrivate: boolean;
}

@Injectable()
export class OAuthClientRegistryService {
  constructor(private readonly surreal: SurrealService) {}

  async find(companyId: string, resource: string): Promise<DynamicClient | null> {
    const row = await this.surreal.withCompany(companyId, (db) =>
      queryFirst<OAuthClientRow>(
        db,
        `SELECT * FROM source_oauth_client WHERE resource = $resource LIMIT 1`,
        { resource },
      ),
    );
    return row ? toClient(row) : null;
  }

  /** Keep (or replace) the client for a resource — one row per resource. */
  async put(
    companyId: string,
    p: {
      resource: string;
      as: AuthorizationServerMetadata;
      client: RegisteredClient;
      registration: 'dynamic' | 'operator';
      scopes: string[];
      allowPrivate: boolean;
    },
  ): Promise<DynamicClient> {
    const content = {
      resource: p.resource,
      origin: new URL(p.resource).origin,
      issuer: p.as.issuer,
      authorizationEndpoint: p.as.authorizationEndpoint,
      tokenEndpoint: p.as.tokenEndpoint,
      ...(p.as.registrationEndpoint ? { registrationEndpoint: p.as.registrationEndpoint } : {}),
      ...(p.as.revocationEndpoint ? { revocationEndpoint: p.as.revocationEndpoint } : {}),
      clientId: p.client.clientId,
      ...(p.client.clientSecret ? { clientSecret: encryptSecret(p.client.clientSecret) } : {}),
      tokenAuth: p.client.tokenAuth,
      scopes: p.scopes,
      registration: p.registration,
      allowPrivate: p.allowPrivate,
    };
    const row = await this.surreal.withCompany(companyId, async (db) => {
      const existing = await queryFirst<OAuthClientRow>(
        db,
        `SELECT id FROM source_oauth_client WHERE resource = $resource LIMIT 1`,
        { resource: p.resource },
      );
      if (existing) {
        const [updated] = await queryRows<OAuthClientRow>(db, `UPDATE $id CONTENT $content`, {
          id: existing.id,
          content: { ...content, updatedAt: new Date() },
        });
        return updated;
      }
      const [created] = await queryRows<OAuthClientRow>(
        db,
        `CREATE source_oauth_client CONTENT $content`,
        { content },
      );
      return created;
    });
    if (!row) throw new Error('source_oauth_client write returned no row');
    return toClient(row);
  }

  async forget(companyId: string, resource: string): Promise<void> {
    await this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<{ id: unknown }>(
        db,
        `SELECT id FROM source_oauth_client WHERE resource = $resource`,
        { resource },
      );
      for (const r of rows) await db.query(`DELETE $id`, { id: r.id });
    });
  }
}

function toClient(row: OAuthClientRow): DynamicClient {
  return {
    resource: row.resource,
    origin: row.origin,
    issuer: row.issuer,
    authorizationEndpoint: row.authorizationEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    revocationEndpoint: row.revocationEndpoint ?? null,
    clientId: row.clientId,
    clientSecret: row.clientSecret ? decryptSecret(row.clientSecret) : '',
    tokenAuth: row.tokenAuth,
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    allowPrivate: row.allowPrivate === true,
  };
}
