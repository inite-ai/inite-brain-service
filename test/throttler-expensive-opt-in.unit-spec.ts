/**
 * `expensive` is opt-in, and a queued mention is an enqueue.
 *
 * Nest applies every configured throttler to every route, so the 10/min
 * model-route cap used to count /v1/ingest/fact and every cheap read too
 * (health.controller.ts had to exempt the probes for that reason). A
 * family product writing every inbox message through one machine
 * credential hit 10/min on writes that cost a few inserts.
 */
import { Reflector } from '@nestjs/core';
import { Throttle, ThrottlerException, type ThrottlerRequest } from '@nestjs/throttler';
import { TenantThrottlerGuard } from '../src/common/tenant-throttler.guard';
import { SurrealThrottlerStorage } from '../src/common/surreal-throttler.storage';
import {
  mentionIngestLimit,
  QUEUED_MENTION_DEFAULT_LIMIT,
  SYNC_MENTION_LIMIT,
} from '../src/common/ingest-throttle';
import { IngestController } from '../src/ingest/ingest.controller';
import { SearchController } from '../src/search/search.controller';

class Routes {
  cheap(): void {}
  @Throttle({ expensive: { limit: 2, ttl: 60_000 } })
  hot(): void {}
}

class TestableGuard extends TenantThrottlerGuard {
  constructor(storage: SurrealThrottlerStorage) {
    super({ throttlers: [] }, storage, new Reflector());
  }
  run(props: ThrottlerRequest) {
    return this.handleRequest(props);
  }
}

function props(handler: () => void, name: string, limit: number): ThrottlerRequest {
  const req = { ip: '203.0.113.9', headers: {} };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: jest.fn() }) }),
    getHandler: () => handler,
    getClass: () => Routes,
  } as unknown as ThrottlerRequest['context'];
  return {
    context,
    limit,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name, limit, ttl: 60_000 },
    getTracker: async () => 'ip:203.0.113.9',
    generateKey: (_ctx, tracker, n) => `${n}:${handler.name}:${tracker}`,
  };
}

describe('the expensive throttler is opt-in', () => {
  it('does not count a route that never declared it', async () => {
    const guard = new TestableGuard(new SurrealThrottlerStorage());
    await guard.onModuleInit();
    for (let i = 0; i < 5; i++) {
      await expect(guard.run(props(Routes.prototype.cheap, 'expensive', 2))).resolves.toBe(true);
    }
  });

  it('still rations a route that declared it', async () => {
    const guard = new TestableGuard(new SurrealThrottlerStorage());
    await guard.onModuleInit();
    await guard.run(props(Routes.prototype.hot, 'expensive', 2));
    await guard.run(props(Routes.prototype.hot, 'expensive', 2));
    await expect(guard.run(props(Routes.prototype.hot, 'expensive', 2))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('still counts every route against default', async () => {
    const guard = new TestableGuard(new SurrealThrottlerStorage());
    await guard.onModuleInit();
    await guard.run(props(Routes.prototype.cheap, 'default', 1));
    await expect(guard.run(props(Routes.prototype.cheap, 'default', 1))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('search keeps its declared cap; mention declares a resolvable one', () => {
    const reflector = new Reflector();
    const limitOf = (handler: unknown): unknown =>
      reflector.get('THROTTLER:LIMITexpensive', handler as () => void);
    expect(limitOf(SearchController.prototype.run)).toBe(10);
    expect(typeof limitOf(IngestController.prototype.ingestMention)).toBe('function');
    expect(limitOf(IngestController.prototype.ingestFact)).toBeUndefined();
  });
});

describe('mention ingest limit', () => {
  const saved = {
    via: process.env.INGEST_MENTION_VIA_DOCUMENT,
    limit: process.env.THROTTLE_INGEST_LIMIT,
  };
  afterEach(() => {
    for (const [k, v] of [
      ['INGEST_MENTION_VIA_DOCUMENT', saved.via],
      ['THROTTLE_INGEST_LIMIT', saved.limit],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a direct (in-request) extraction keeps 10/min', () => {
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    process.env.THROTTLE_INGEST_LIMIT = '5000';
    expect(mentionIngestLimit()).toBe(SYNC_MENTION_LIMIT);
  });

  it('a queued mention gets THROTTLE_INGEST_LIMIT, 600 by default', () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    delete process.env.THROTTLE_INGEST_LIMIT;
    expect(mentionIngestLimit()).toBe(QUEUED_MENTION_DEFAULT_LIMIT);
    process.env.THROTTLE_INGEST_LIMIT = '1200';
    expect(mentionIngestLimit()).toBe(1200);
    process.env.THROTTLE_INGEST_LIMIT = 'nonsense';
    expect(mentionIngestLimit()).toBe(QUEUED_MENTION_DEFAULT_LIMIT);
  });
});
