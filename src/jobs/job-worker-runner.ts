/**
 * Generic worker_thread entry point used by JobWorkerPool.
 *
 * Each pool worker boots, signals ready, and then handles inbound
 * `{ id, modulePath, input }` requests by:
 *   1. Dynamic-importing modulePath (cached after the first import).
 *   2. Calling its exported `run(input)` function.
 *   3. Posting `{ id, ok: true, result }` (or `{ id, ok: false, error }`)
 *      back to the parent.
 *
 * The worker file is intentionally tiny — the only contract is the
 * envelope. Real per-job logic lives in the handler module, which the
 * caller registers with the pool via a known path. Because each
 * handler is a separate import, the pool can serve heterogeneous
 * CPU-bound jobs (reindex embeddings, multi-pass extractor, batch
 * normalisation) without spawning per-handler workers.
 *
 * Resolution: the parent passes either a path that exists at runtime
 * (typically `<__dirname>/<handler>.worker-job.js` after nest build)
 * or — under ts-jest / dev — the corresponding `.ts`. Same convention
 * as bge-m3.worker so all worker resolution lives in one place.
 */
import { parentPort } from 'node:worker_threads';

interface InboundRun {
  id: number;
  kind: 'run';
  modulePath: string;
  input: unknown;
}

interface InboundShutdown {
  id: number;
  kind: 'shutdown';
}

type Inbound = InboundRun | InboundShutdown;

type Outbound =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; name?: string };

interface JobWorkerHandlerModule {
  run: (input: unknown) => Promise<unknown>;
}

const moduleCache = new Map<string, JobWorkerHandlerModule>();

if (!parentPort) {
  // We were imported (not spawned via new Worker) — exit silently so
  // ts-jest's typecheck doesn't run worker code in the main test
  // process. Real worker entry always has parentPort.
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

const port = parentPort;

port.on('message', async (msg: Inbound) => {
  if (msg.kind === 'shutdown') {
    port.postMessage({ id: msg.id, ok: true, result: null } satisfies Outbound);
    // Let the parent close the worker cleanly via worker.terminate().
    return;
  }
  if (msg.kind !== 'run') return;
  try {
    let mod = moduleCache.get(msg.modulePath);
    if (!mod) {
      const imported = (await import(msg.modulePath)) as JobWorkerHandlerModule;
      if (typeof imported.run !== 'function') {
        throw new Error(
          `Job worker module ${msg.modulePath} is missing an exported run(input) function`,
        );
      }
      mod = imported;
      moduleCache.set(msg.modulePath, mod);
    }
    const result = await mod.run(msg.input);
    port.postMessage({ id: msg.id, ok: true, result } satisfies Outbound);
  } catch (e) {
    const err = e as Error;
    port.postMessage({
      id: msg.id,
      ok: false,
      error: err.message,
      name: err.name,
    } satisfies Outbound);
  }
});

// Boot ack — parent waits on this before considering the worker
// "ready" in its pool accounting. id=0 is reserved.
port.postMessage({ id: 0, ok: true, result: 'ready' } satisfies Outbound);
