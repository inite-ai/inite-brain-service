import { Controller, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { requestBaseUrl } from '../../auth/resource-metadata';
import type { WebhookReceipt } from '../../contracts/source-plane/source-plane.schema';
import { RecordsWebhookService } from './records-webhook.service';
import type { WebhookRequest } from './webhook-schemes';

/**
 * The vendor's leg — PUBLIC by construction (a CRM calls with no brain
 * credential; the signed address names the tenant and the connection,
 * the vendor's signature or the connection's secret authenticates).
 * Mounted on `/v1/source-connections/webhook/:address`, beside the
 * OAuth callback. The raw body is kept for the vendors that sign it
 * (HubSpot v3 signs method + URL + body + timestamp), so the app runs
 * with `rawBody: true`.
 *
 * Bare 404 while SOURCE_WEBHOOKS is off, for an unknown address, and
 * for a connection whose webhook is off — nothing to enumerate.
 */
@Controller('v1/source-connections/webhook')
export class SourceWebhookController {
  constructor(private readonly webhooks: RecordsWebhookService) {}

  @Post(':address')
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Param('address') address: string,
  ): Promise<WebhookReceipt> {
    return this.webhooks.receive(address, webhookRequestOf(req));
  }
}

/** The request as the schemes see it: lower-cased headers, the raw bytes, the parsed body, the URL the vendor called. */
export function webhookRequestOf(req: RawBodyRequest<Request>): WebhookRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v[0] !== undefined) headers[k.toLowerCase()] = v[0];
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (typeof v === 'string') query[k] = v;
  }
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''), 'utf8');
  const base = requestBaseUrl(req) ?? '';
  return {
    method: req.method ?? 'POST',
    url: `${base}${req.originalUrl ?? req.url ?? ''}`,
    headers,
    rawBody,
    body: req.body,
    query,
  };
}
