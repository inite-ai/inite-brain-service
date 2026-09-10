/**
 * BgeM3EmbedderProvider worker handlers are scoped to THEIR worker.
 *
 * A timed-out RPC terminates the worker (worker = null, synchronously) and
 * the owner re-arms a warmup that builds a fresh one — while the old thread
 * is still exiting. Its late 'exit' / 'error' must not reject the new
 * worker's pending warmup or mark the provider not-ready for a thread it
 * no longer owns.
 */
import { EventEmitter } from 'node:events';
import {
  BgeM3EmbedderProvider,
  type InferenceWorker,
} from '../src/ai/embedder/bge-m3-embedder.provider';
import { declaredSpace } from '../src/ai/embedder/embedding-space';

interface Rpc {
  id: number;
  kind: string;
}

/** A worker thread stand-in: `terminate()` resolves at once (the real thread
 *  exits later, which the test emits by hand). */
class FakeWorker extends EventEmitter implements InferenceWorker {
  constructor(private readonly onRpc: (w: FakeWorker, rpc: Rpc) => void) {
    super();
  }
  postMessage(value: unknown): void {
    this.onRpc(this, value as Rpc);
  }
  async terminate(): Promise<number> {
    return 0;
  }
}

function provider(onRpc: (w: FakeWorker, rpc: Rpc) => void) {
  const workers: FakeWorker[] = [];
  const p = new BgeM3EmbedderProvider({
    space: declaredSpace('bge-m3'),
    concurrency: 1,
    useWorker: true,
    createWorker: () => {
      const w = new FakeWorker(onRpc);
      workers.push(w);
      return w;
    },
  });
  return { p, workers };
}

const ready = (w: FakeWorker, rpc: Rpc) =>
  w.emit('message', { id: rpc.id, ok: true, result: { ready: true } });

describe('BgeM3EmbedderProvider — worker handler scoping', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a terminated worker exiting late does not fail the replacement warmup', async () => {
    const { p, workers } = provider((w, rpc) => {
      // Worker 1 never answers; worker 2 answers only after the old thread
      // finally exits — the interleaving a timed-out warmup produces.
      if (w !== workers[0]) {
        workers[0]!.emit('exit', 1);
        ready(w, rpc);
      }
    });
    const first = p.warmup();
    first.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(120_000);
    await expect(first).rejects.toThrow(/timed out/);
    expect(p.isReady()).toBe(false);

    await expect(p.warmup()).resolves.toBeUndefined();
    expect(p.isReady()).toBe(true);
    expect(workers).toHaveLength(2);
    await p.terminate();
  });

  it("a replaced worker's late error is ignored as well", async () => {
    const { p, workers } = provider((w, rpc) => {
      if (w !== workers[0]) {
        workers[0]!.emit('error', new Error('old thread crashed while unloading'));
        ready(w, rpc);
      }
    });
    const first = p.warmup();
    first.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(120_000);
    await expect(first).rejects.toThrow(/timed out/);

    await expect(p.warmup()).resolves.toBeUndefined();
    expect(p.isReady()).toBe(true);
    await p.terminate();
  });

  it("the CURRENT worker's exit still fails its pending RPCs and flips not-ready", async () => {
    const { p, workers } = provider((w, rpc) => {
      if (rpc.kind === 'warmup') ready(w, rpc);
      // embed: never answered — the exit must reject it.
    });
    await expect(p.warmup()).resolves.toBeUndefined();
    const embed = p.embed('cats');
    embed.catch(() => undefined);
    // The RPC is registered behind the concurrency semaphore's await, so
    // let the microtasks run before the thread dies under it.
    await jest.advanceTimersByTimeAsync(0);
    workers[0]!.emit('exit', 1);
    await expect(embed).rejects.toThrow(/worker exited/);
    expect(p.isReady()).toBe(false);
    await p.terminate();
  });
});
