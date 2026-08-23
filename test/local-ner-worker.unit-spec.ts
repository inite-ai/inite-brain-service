/**
 * Unit-test for the LocalNerService worker runtime — the default
 * EXTRACTOR_LOCAL_NER_WORKER=1 path with node:worker_threads mocked
 * (no model download, no real thread).
 *
 * Proves the degradation contract: a worker that is not ready, times
 * out, or crashes always degrades to the feature's existing
 * unavailable behavior (extract() → []), a timeout latches re-warmup
 * for FAIL_RETRY_MS, the test seam still drives the in-thread path,
 * and shutdown terminates the thread.
 */
import type { ConfigService } from '@nestjs/config';
import { LocalNerService } from '../src/ai/local-ner.service';

// jest.mock is hoisted above the imports, so LocalNerService sees the fake.
jest.mock('node:worker_threads', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    readonly listeners = new Map<string, (arg: any) => void>();
    readonly posted: Array<{ id: number; kind: string; payload: any }> = [];
    terminated = false;
    constructor(public readonly path: string) {
      FakeWorker.instances.push(this);
    }
    on(event: string, fn: (arg: any) => void): this {
      this.listeners.set(event, fn);
      return this;
    }
    postMessage(msg: { id: number; kind: string; payload: any }): void {
      this.posted.push(msg);
    }
    async terminate(): Promise<number> {
      this.terminated = true;
      return 0;
    }
  }
  return { Worker: FakeWorker };
});

interface FakeWorkerT {
  instances: FakeWorkerT[];
  listeners: Map<string, (arg: any) => void>;
  posted: Array<{ id: number; kind: string; payload: any }>;
  terminated: boolean;
  path: string;
}

const FakeWorker = (
  jest.requireMock('node:worker_threads') as { Worker: { instances: FakeWorkerT[] } }
).Worker;

function mkConfig(over: Record<string, string> = {}): ConfigService {
  const data: Record<string, string> = {
    EXTRACTOR_LOCAL_NER_ENABLED: 'true',
    EXTRACTOR_LOCAL_NER_MIN_SCORE: '0.7',
    ...over,
  };
  return {
    get: (k: string, def?: string) => data[k] ?? def,
  } as unknown as ConfigService;
}

function replyToLast(w: FakeWorkerT, ok: boolean, body: unknown): void {
  const last = w.posted[w.posted.length - 1]!;
  const msg = ok
    ? { id: last.id, ok: true, result: body }
    : { id: last.id, ok: false, error: String(body) };
  w.listeners.get('message')!(msg);
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  FakeWorker.instances.length = 0;
});

describe('LocalNerService — worker runtime', () => {
  it('extract before the worker is ready returns [] and kicks background warmup', async () => {
    const svc = new LocalNerService(mkConfig());
    expect(svc.isReady()).toBe(false);
    await expect(svc.extract('Maria works at Acme')).resolves.toEqual([]);
    // The not-ready call fired a background warmup: worker spawned, warmup RPC posted.
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0]!;
    expect(w.posted[0]!.kind).toBe('warmup');
    // Complete warmup → ready; extract now round-trips through the worker.
    replyToLast(w, true, { ready: true });
    await flush();
    expect(svc.isReady()).toBe(true);
  });

  it('scores flow through the worker RPC with min-score filtering intact', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.onModuleInit();
    const w = FakeWorker.instances[0]!;
    replyToLast(w, true, { ready: true });
    await flush();

    const pending = svc.extract('Maria Petrov is CTO at Acme');
    await flush();
    expect(w.posted[1]).toMatchObject({
      kind: 'extract',
      payload: { text: 'Maria Petrov is CTO at Acme' },
    });
    replyToLast(w, true, [
      { word: 'Maria Petrov', entity_group: 'PER', start: 0, end: 12, score: 0.95 },
      { word: 'Acme', entity_group: 'org', start: 23, end: 27, score: 0.85 },
      { word: 'low', entity_group: 'MISC', start: 0, end: 3, score: 0.5 },
    ]);
    const out = await pending;
    expect(out).toEqual([
      { text: 'Maria Petrov', type: 'PER', start: 0, end: 12, score: 0.95 },
      { text: 'Acme', type: 'ORG', start: 23, end: 27, score: 0.85 },
    ]);
    // Cached: a repeat extract does not post a second RPC.
    await expect(svc.extract('Maria Petrov is CTO at Acme')).resolves.toEqual(out);
    expect(w.posted).toHaveLength(2);
  });

  it('a worker-side error degrades to [] (existing unavailable behavior)', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.onModuleInit();
    const w = FakeWorker.instances[0]!;
    replyToLast(w, true, { ready: true });
    await flush();

    const pending = svc.extract('anything');
    await flush();
    replyToLast(w, false, 'boom');
    await expect(pending).resolves.toEqual([]);
  });

  it('RPC timeout falls back to [] and latches re-warmup', async () => {
    const svc = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_TIMEOUT_MS: '25' }),
    );
    svc.onModuleInit();
    const w = FakeWorker.instances[0]!;
    replyToLast(w, true, { ready: true });
    await flush();

    // Never reply → the per-call deadline fires and the call degrades to [].
    await expect(svc.extract('wedged host')).resolves.toEqual([]);
    expect(svc.isReady()).toBe(false);
    // Latched: the next extract neither RPCs the wedged worker nor spawns a
    // replacement within the retry window.
    await expect(svc.extract('next call')).resolves.toEqual([]);
    expect(w.posted).toHaveLength(2); // warmup + the timed-out extract only
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('the test seam (in-thread classifier) takes precedence over the worker', async () => {
    const svc = new LocalNerService(mkConfig());
    const pipe = jest.fn(async () => [
      { word: 'Berlin', entity_group: 'LOC', start: 0, end: 6, score: 0.9 },
    ]);
    svc.setClassifierForTesting(pipe as any);
    const out = await svc.extract('Berlin');
    expect(out).toHaveLength(1);
    expect(pipe).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('never spawns a worker when the feature is disabled or the worker flag is off', async () => {
    const disabled = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_ENABLED: 'false' }),
    );
    disabled.onModuleInit();
    await expect(disabled.extract('text')).resolves.toEqual([]);

    const inThread = new LocalNerService(
      mkConfig({ EXTRACTOR_LOCAL_NER_WORKER: '0' }),
    );
    await expect(inThread.extract('text')).resolves.toEqual([]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('onApplicationShutdown terminates the worker and rejects in-flight calls to []', async () => {
    const svc = new LocalNerService(mkConfig());
    svc.onModuleInit();
    const w = FakeWorker.instances[0]!;
    replyToLast(w, true, { ready: true });
    await flush();

    const inflight = svc.extract('in flight');
    await flush();
    await svc.onApplicationShutdown();
    expect(w.terminated).toBe(true);
    await expect(inflight).resolves.toEqual([]);
    expect(svc.isReady()).toBe(false);
  });
});
