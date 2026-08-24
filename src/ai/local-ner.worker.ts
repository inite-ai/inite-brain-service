/**
 * Worker thread that owns the local NER token-classification model.
 *
 * Why a dedicated worker: @xenova/transformers runs ONNX inference (WASM or
 * native) on the main thread by default. The NER model
 * (Xenova/bert-base-multilingual-cased-ner-hrl, ~135MB ONNX) takes tens of
 * milliseconds per text; running it in-thread during ingest stalls the event
 * loop — and every other tenant's request — for the whole pass. Hosting the
 * model in a worker_thread confines the blocking to a dedicated loop, exactly
 * as the cross-encoder (src/ai/cross-encoder/cross-encoder.worker.ts) and the
 * BGE-M3 embedder (src/ai/embedder/bge-m3.worker.ts) do.
 *
 * Protocol: parent posts `{ id, kind, payload }`; worker replies with
 * `{ id, ok, result | error }`. id demuxes concurrent requests.
 */
import { parentPort } from 'node:worker_threads';

interface WorkerConfig {
  modelId: string;
}

type TokenClassificationPipeline = (
  text: string,
  options?: { aggregation_strategy?: string },
) => Promise<
  Array<{
    entity_group?: string;
    entity?: string;
    word: string;
    start: number;
    end: number;
    score: number;
  }>
>;

type Inbound =
  | { id: number; kind: 'warmup'; payload: WorkerConfig }
  | { id: number; kind: 'extract'; payload: { text: string } };

type Outbound =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error('local-ner.worker must be run as a worker_thread');
}

let classifier: TokenClassificationPipeline | null = null;
let warmupPromise: Promise<void> | null = null;

function reply(msg: Outbound): void {
  parentPort!.postMessage(msg);
}

async function warmup(cfg: WorkerConfig): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string };
      pipeline: (task: string, model: string) => Promise<unknown>;
    };
    // transformers.js v2 ignores the python-style TRANSFORMERS_CACHE / HF_HOME
    // env vars — it resolves its own default under node_modules, which is
    // root-owned (and re-downloaded on every restart) in the Docker image.
    // Honour the env explicitly so the operator's cache mount actually works.
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    classifier = (await t.pipeline(
      'token-classification',
      cfg.modelId,
    )) as unknown as TokenClassificationPipeline;
  })();
  return warmupPromise;
}

async function extract(p: { text: string }): Promise<unknown[]> {
  if (!classifier) throw new Error('local NER not ready');
  const raw = await classifier(p.text, { aggregation_strategy: 'simple' });
  // Copy into plain objects: keeps the reply structured-clone-safe even if
  // the pipeline returns class instances or tensor-backed fields, and drops
  // everything the parent doesn't consume.
  return raw.map((r) => ({
    entity_group: r.entity_group,
    entity: r.entity,
    word: r.word,
    start: r.start,
    end: r.end,
    score: Number(r.score),
  }));
}

const onMessage = async (msg: Inbound): Promise<void> => {
  try {
    if (msg.kind === 'warmup') {
      await warmup(msg.payload);
      reply({ id: msg.id, ok: true, result: { ready: true } });
      return;
    }
    if (warmupPromise) await warmupPromise;
    if (msg.kind === 'extract') {
      reply({ id: msg.id, ok: true, result: await extract(msg.payload) });
      return;
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: (e as Error).message });
  }
};

// The message listener is void-returning and each message is handled
// independently, so the async work runs detached. onMessage already reports
// business failures to the parent via reply(); the .catch guards only a
// catastrophic reply()/port failure from becoming an unhandledRejection.
parentPort.on('message', (msg: Inbound) => {
  void onMessage(msg).catch((err) => {
    console.error(`local-ner worker handler crashed: ${(err as Error).message}`);
  });
});
