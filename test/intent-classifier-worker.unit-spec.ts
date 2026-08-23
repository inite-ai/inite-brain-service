/**
 * Unit coverage for the IntentClassifierService worker runtime
 * (CHAT_ROUTE_NLI_WORKER, default ON):
 *   - worker not warmed → punctuation fallback (marker intact)
 *   - warmed worker → classify RPC flows through, result cached on main
 *   - classify RPC timeout → punctuation fallback + 5-min failure latch
 *     (no immediate replacement-worker churn)
 *   - application shutdown terminates the worker thread
 *
 * worker_threads.Worker is hand-rolled-mocked (house style, see
 * worker-loop.unit-spec.ts) — no model download, no real thread.
 */
import { ConfigService } from '@nestjs/config';

interface RpcMessage {
  id: number;
  kind: string;
  payload: unknown;
}

class MockWorker {
  readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  readonly posted: RpcMessage[] = [];
  terminated = false;

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  postMessage(msg: RpcMessage): void {
    this.posted.push(msg);
    mockOnPost?.(this, msg);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  emit(event: string, arg?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}

const mockWorkers: MockWorker[] = [];
let mockOnPost: ((w: MockWorker, msg: RpcMessage) => void) | null = null;

jest.mock('node:worker_threads', () => ({
  Worker: jest.fn(() => {
    const w = new MockWorker();
    mockWorkers.push(w);
    return w;
  }),
}));

// Imported after the mock declaration for readability; jest hoists the
// jest.mock() call above imports either way, so the service binds the
// mocked Worker.
import { IntentClassifierService } from '../src/admin/intent-classifier.service';

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    CHAT_ROUTE_NLI_ENABLED: 'true',
    CHAT_ROUTE_NLI_ASK_THRESHOLD: '0.6',
    CHAT_ROUTE_NLI_WORKER: '1',
    CHAT_ROUTE_NLI_TIMEOUT_MS: '40',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

async function waitFor(cond: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Boot the service and answer the warmup RPC so the worker goes ready. */
async function warmService(svc: IntentClassifierService): Promise<MockWorker> {
  const previous = mockOnPost;
  mockOnPost = (w, msg) => {
    if (msg.kind === 'warmup') {
      queueMicrotask(() =>
        w.emit('message', { id: msg.id, ok: true, result: { ready: true } }),
      );
      return;
    }
    previous?.(w, msg);
  };
  svc.onModuleInit();
  await waitFor(() => svc.isReady());
  mockOnPost = previous;
  return mockWorkers[mockWorkers.length - 1]!;
}

beforeEach(() => {
  mockWorkers.length = 0;
  mockOnPost = null;
});

describe('IntentClassifierService — worker runtime', () => {
  it('worker not warmed → punctuation fallback, no RPC', async () => {
    const svc = new IntentClassifierService(mkConfig());
    // onModuleInit fired, but the (mock) worker never answers warmup —
    // the model is still "downloading".
    svc.onModuleInit();
    expect(svc.isReady()).toBe(false);
    await expect(svc.classify('Maria moved to Berlin')).resolves.toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
    expect(mockWorkers).toHaveLength(1);
    expect(
      mockWorkers[0]!.posted.filter((m) => m.kind === 'classify'),
    ).toHaveLength(0);
    await svc.onApplicationShutdown();
  });

  it('warmed worker → classify RPC carries {text, labels, hypothesisTemplate}; result cached on the main thread', async () => {
    const svc = new IntentClassifierService(mkConfig());
    mockOnPost = (w, msg) => {
      if (msg.kind !== 'classify') return;
      queueMicrotask(() =>
        w.emit('message', {
          id: msg.id,
          ok: true,
          result: { labels: ['question', 'statement'], scores: [0.82, 0.18] },
        }),
      );
    };
    const worker = await warmService(svc);

    const first = await svc.classify('where Maria lives');
    expect(first).toEqual({ intent: 'ask', confidence: 0.82, source: 'nli' });
    const classifyCalls = worker.posted.filter((m) => m.kind === 'classify');
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.payload).toEqual({
      text: 'where Maria lives',
      labels: ['question', 'statement'],
      hypothesisTemplate: 'This text is a {}.',
    });

    // Repeat query: served from the main-thread LRU, no second RPC.
    const second = await svc.classify('where Maria lives');
    expect(second).toEqual({
      intent: 'ask',
      confidence: 0.82,
      source: 'cache',
    });
    expect(worker.posted.filter((m) => m.kind === 'classify')).toHaveLength(1);
    await svc.onApplicationShutdown();
  });

  it('classify RPC timeout → punctuation fallback + failure latch (no worker churn)', async () => {
    const svc = new IntentClassifierService(
      mkConfig({ CHAT_ROUTE_NLI_TIMEOUT_MS: '30' }),
    );
    // Never answer classify RPCs — a wedged worker.
    const worker = await warmService(svc);

    const timedOut = await svc.classify('a statement that never scores');
    expect(timedOut).toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
    // The timeout dropped readiness…
    expect(svc.isReady()).toBe(false);

    // …and latched: the next miss short-circuits to punctuation without a
    // new RPC and without spawning a replacement worker mid-latch.
    const duringLatch = await svc.classify('another plain statement');
    expect(duringLatch).toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
    expect(worker.posted.filter((m) => m.kind === 'classify')).toHaveLength(1);
    expect(mockWorkers).toHaveLength(1);
    await svc.onApplicationShutdown();
  });

  it('onApplicationShutdown terminates the worker thread', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const worker = await warmService(svc);
    expect(svc.isReady()).toBe(true);

    await svc.onApplicationShutdown();
    expect(worker.terminated).toBe(true);
    expect(svc.isReady()).toBe(false);

    // Idempotent: a second shutdown is a no-op.
    await expect(svc.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('worker crash (exit) → punctuation fallback for in-flight and later calls', async () => {
    const svc = new IntentClassifierService(mkConfig());
    const worker = await warmService(svc);

    const inFlight = svc.classify('statement pending when the worker dies');
    await waitFor(
      () => worker.posted.filter((m) => m.kind === 'classify').length === 1,
    );
    worker.emit('exit', 1);
    await expect(inFlight).resolves.toEqual({
      intent: 'tell',
      confidence: 0.7,
      source: 'punctuation',
    });
    expect(svc.isReady()).toBe(false);
    await expect(svc.classify('after the crash')).resolves.toMatchObject({
      source: 'punctuation',
    });
    await svc.onApplicationShutdown();
  });
});
