/* eslint-disable max-classes-per-file -- one tiny error taxonomy for instanceof dispatch, not three responsibilities */
/**
 * Error taxonomy for the billing-service client (billing.inite.ai).
 * Plain Error subclasses — no Nest dependencies — so the pure gate logic
 * and the HTTP layer can each map them to their own failure shapes:
 * disabled → 400 (write surfaces), unavailable → 503 (fail-closed:
 * entitlements cannot be verified), request → 502 (billing answered,
 * but with a caller-side 4xx we can't act on).
 */

/** Billing integration is off (DOMAIN_PACK_BILLING_ENABLED unset/0). */
export class BillingDisabledError extends Error {
  constructor() {
    super('billing integration is disabled on this instance');
    this.name = 'BillingDisabledError';
  }
}

/** The billing service could not be reached: timeout, network error or a
 *  5xx answer (after the read-path retry). Callers MUST fail closed. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingUnavailableError';
  }
}

/** The billing service answered with a 4xx — the request itself was
 *  rejected. Carries the status and a body snippet for diagnostics. */
export class BillingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(`billing service answered HTTP ${status}: ${bodySnippet}`);
    this.name = 'BillingRequestError';
  }
}
