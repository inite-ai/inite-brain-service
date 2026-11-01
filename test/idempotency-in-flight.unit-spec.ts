/**
 * A retry that arrives while the first request under its Idempotency-Key
 * is still running is a 409 that will resolve: once the first finishes,
 * the same retry gets the stored answer. Retry-After is how a client tells
 * that 409 from a conflict that will be the same answer next time, and the
 * SDK retries only a 409 that carries one.
 */
import { ConflictException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import {
  IN_FLIGHT_RETRY_AFTER_S,
  IdempotencyInterceptor,
} from '../src/idempotency/idempotency.interceptor';
import type { IdempotencyStoreService } from '../src/idempotency/idempotency-store.service';

class FactsController {
  record(): void {}
}

function context() {
  const setHeader = jest.fn();
  const req = {
    method: 'POST',
    headers: { 'idempotency-key': 'k-1' },
    path: '/v1/ingest/fact',
    params: {},
    query: {},
    body: { predicate: 'lives_in' },
    brainAuth: { companyId: 'co_x', keyHash: 'h' },
  };
  const ctx = {
    getType: () => 'http',
    getClass: () => FactsController,
    getHandler: () => FactsController.prototype.record,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }),
  } as unknown as ExecutionContext;
  return { ctx, setHeader };
}

function interceptor(kind: 'in_flight' | 'mismatch') {
  const store = { begin: jest.fn(async () => ({ kind })) } as unknown as IdempotencyStoreService;
  return new IdempotencyInterceptor(store, new Reflector());
}

describe('Idempotency-Key — a retry while the first request still runs', () => {
  it('is a 409 that says when to come back', async () => {
    const { ctx, setHeader } = context();
    const handler = { handle: jest.fn(() => of('ran')) };
    await expect(
      lastValueFrom(interceptor('in_flight').intercept(ctx, handler)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', String(IN_FLIGHT_RETRY_AFTER_S));
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('a key reused for a different request is a 422 with no Retry-After: retrying cannot help', async () => {
    const { ctx, setHeader } = context();
    const handler = { handle: jest.fn(() => of('ran')) };
    await expect(
      lastValueFrom(interceptor('mismatch').intercept(ctx, handler)),
    ).rejects.toMatchObject({
      status: 422,
    });
    expect(setHeader).not.toHaveBeenCalled();
  });
});
