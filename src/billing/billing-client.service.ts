import { Injectable, Logger } from '@nestjs/common';
import { envFlagEnabled } from '../common/env-validation';
import {
  BillingDisabledError,
  BillingRequestError,
  BillingUnavailableError,
} from './billing-errors';

/** Product row as the billing catalog API returns it (fields we read). */
interface BillingProduct {
  id: string;
  code: string;
}

interface BillingEntitlement {
  key: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ENTITLEMENT_CACHE_TTL_MS = 60_000;

/**
 * HTTP client for the central billing service (billing.inite.ai) — the
 * paid-packs leg of the registry marketplace (docs/domain-packs.md
 * "Marketplace"). Brain is registered there as ONE `Service` and
 * authenticates with `x-api-key`; the billing `userId` for every call is
 * the brain `companyId` (free-form varchar on their side).
 *
 * Posture:
 *   - Pull-only + cache: billing v1 has no signed inbound webhooks, so
 *     entitlements are polled (GET /v1/entitlements/:userId) behind a
 *     short in-memory TTL cache. The cache is never served stale — an
 *     expired entry plus an unreachable billing service throws
 *     BillingUnavailableError, and callers fail CLOSED (paid installs
 *     refuse rather than leak).
 *   - Env is read lazily per call (like the registry mirror), so the
 *     integration can be toggled without a restart.
 *   - Retries: reads (entitlements, product list) get 1 retry on
 *     timeout/network/5xx with ~250ms jitter; writes (product/price/
 *     checkout creation) get none — the billing side dedupes checkout
 *     via the forwarded idempotency-key instead.
 */
@Injectable()
export class BillingClientService {
  private readonly logger = new Logger(BillingClientService.name);
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl: typeof fetch = fetch;
  private readonly entitlementCache = new Map<
    string,
    { keys: Set<string>; expiresAt: number }
  >();

  /** Feature switch — every marketplace surface checks this first.
   *  Off (the default) = self-hosted posture: paid metadata is ignored
   *  and every pack installs free. */
  enabled(): boolean {
    return envFlagEnabled(process.env.DOMAIN_PACK_BILLING_ENABLED);
  }

  /**
   * Idempotently ensure the billing catalogue carries a product for the
   * pack (code `pack_<packId>`, entitlement key `domain_pack:<packId>`)
   * and mint a NEW price for it. Billing prices are immutable, so every
   * re-price mints a fresh epoch-suffixed priceCode; old codes keep
   * resolving for sessions already in flight.
   */
  async ensurePackProductAndPrice(args: {
    packId: string;
    amount: number;
    currency: string;
  }): Promise<{ productId: string; priceCode: string }> {
    const code = `pack_${args.packId}`;
    let product = await this.findProduct(code);
    if (!product) {
      try {
        product = (await this.request({
          method: 'POST',
          path: '/v1/service/catalog/products',
          body: {
            code,
            name: `Domain Pack ${args.packId}`,
            type: 'one_time',
            metadata: { entitlements: [`domain_pack:${args.packId}`] },
          },
        })) as BillingProduct;
      } catch (e) {
        // Duplicate-code conflict: a concurrent re-price won the CREATE.
        // Re-list — the winner's product is the one we wanted anyway.
        if (!(e instanceof BillingRequestError)) throw e;
        product = await this.findProduct(code);
        if (!product) throw e;
      }
    }
    const priceCode = `${code}_${Math.floor(Date.now() / 1000)}`;
    await this.request({
      method: 'POST',
      path: '/v1/service/catalog/prices',
      body: {
        code: priceCode,
        productId: product.id,
        amount: args.amount,
        currency: args.currency,
      },
    });
    return { productId: product.id, priceCode };
  }

  /** Create a hosted checkout session for a pack purchase. The optional
   *  idempotency key is forwarded verbatim so client retries collapse
   *  into one order on the billing side. */
  async createCheckoutSession(args: {
    companyId: string;
    priceCode: string;
    packId: string;
    successUrl?: string;
    errorUrl?: string;
    idempotencyKey?: string;
  }): Promise<{ sessionId: string; checkoutUrl: string }> {
    const res = (await this.request({
      method: 'POST',
      path: '/v1/checkout/sessions',
      body: {
        priceCode: args.priceCode,
        mode: 'PAYMENT',
        // Service callers pass the buyer in the body; brain's tenant id
        // IS the billing userId (see class doc).
        userId: args.companyId,
        ...(args.successUrl ? { successUrl: args.successUrl } : {}),
        ...(args.errorUrl ? { errorUrl: args.errorUrl } : {}),
        metadata: {
          packId: args.packId,
          companyId: args.companyId,
          source: 'brain_marketplace',
        },
      },
      ...(args.idempotencyKey
        ? { headers: { 'idempotency-key': args.idempotencyKey } }
        : {}),
    })) as { sessionId?: unknown; checkoutUrl?: unknown };
    if (typeof res?.sessionId !== 'string' || typeof res?.checkoutUrl !== 'string') {
      throw new BillingUnavailableError(
        'billing checkout answered without sessionId/checkoutUrl',
      );
    }
    return { sessionId: res.sessionId, checkoutUrl: res.checkoutUrl };
  }

  /** Does the company hold an active entitlement `key`? TTL-cached per
   *  company; NEVER served stale (expired cache + billing down throws —
   *  the caller decides what fail-closed means for its surface). */
  async hasEntitlement(args: {
    companyId: string;
    key: string;
  }): Promise<boolean> {
    const cached = this.entitlementCache.get(args.companyId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys.has(args.key);
    }
    const rows = (await this.request({
      path: `/v1/entitlements/${encodeURIComponent(args.companyId)}`,
      retries: 1,
    })) as BillingEntitlement[];
    const keys = new Set(
      (Array.isArray(rows) ? rows : []).map((r) => String(r.key)),
    );
    this.entitlementCache.set(args.companyId, {
      keys,
      expiresAt: Date.now() + this.cacheTtlMs(),
    });
    return keys.has(args.key);
  }

  /** Test seam — also useful after an operator grants an entitlement
   *  out-of-band and doesn't want to wait out the TTL. */
  clearEntitlementCache(): void {
    this.entitlementCache.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async findProduct(code: string): Promise<BillingProduct | null> {
    const products = (await this.request({
      path: '/v1/service/catalog/products',
      retries: 1,
    })) as BillingProduct[];
    return (
      (Array.isArray(products) ? products : []).find((p) => p.code === code) ??
      null
    );
  }

  /** One billing HTTP roundtrip: x-api-key auth, per-call timeout, 4xx →
   *  BillingRequestError (never retried), timeout/network/5xx →
   *  BillingUnavailableError after `retries` extra attempts. */
  private async request(args: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    retries?: number;
  }): Promise<unknown> {
    if (!this.enabled()) throw new BillingDisabledError();
    const base = (process.env.BILLING_SERVICE_URL ?? '').trim().replace(/\/+$/, '');
    const apiKey = (process.env.BILLING_SERVICE_API_KEY ?? '').trim();
    if (!base || !apiKey) {
      // validateBillingEnv rejects this at boot; guard env drift after.
      // Fail CLOSED (unavailable), never open (disabled would let paid
      // packs install free).
      throw new BillingUnavailableError(
        'BILLING_SERVICE_URL / BILLING_SERVICE_API_KEY not configured',
      );
    }
    const attempts = 1 + Math.max(args.retries ?? 0, 0);
    let lastFailure = 'unreachable';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        // ~250ms full-jitter pause so a herd of retries doesn't synchronise.
        await new Promise((r) => {
          const t = setTimeout(r, 150 + Math.random() * 200);
          t.unref?.();
        });
      }
      const outcome = await this.attempt({ ...args, base, apiKey });
      if (outcome.kind === 'ok') return outcome.body;
      lastFailure = outcome.failure;
    }
    throw new BillingUnavailableError(
      `billing service ${args.method ?? 'GET'} ${args.path} failed: ${lastFailure}`,
    );
  }

  /** A single fetch attempt. 4xx throws immediately (not retriable);
   *  everything transient is returned as a failure for the retry loop. */
  private async attempt(args: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    base: string;
    apiKey: string;
  }): Promise<{ kind: 'ok'; body: unknown } | { kind: 'fail'; failure: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    timer.unref?.();
    try {
      const res = await this.fetchImpl(`${args.base}${args.path}`, {
        method: args.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': args.apiKey,
          ...(args.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(args.headers ?? {}),
        },
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
        signal: controller.signal,
      });
      if (res.status >= 400 && res.status < 500) {
        const text = await res.text().catch(() => '');
        throw new BillingRequestError(res.status, text.slice(0, 200));
      }
      if (!res.ok) {
        this.logger.warn(
          `billing ${args.method ?? 'GET'} ${args.path} answered HTTP ${res.status}`,
        );
        return { kind: 'fail', failure: `HTTP ${res.status}` };
      }
      try {
        return { kind: 'ok', body: await res.json() };
      } catch {
        return { kind: 'fail', failure: 'malformed JSON response' };
      }
    } catch (e) {
      if (e instanceof BillingRequestError) throw e;
      return { kind: 'fail', failure: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  private timeoutMs(): number {
    const n = parseInt(process.env.BILLING_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  }

  private cacheTtlMs(): number {
    const n = parseInt(process.env.BILLING_ENTITLEMENT_CACHE_TTL_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENTITLEMENT_CACHE_TTL_MS;
  }
}
