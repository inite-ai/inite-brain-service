/**
 * Worker thread that owns the zero-shot NLI intent model.
 *
 * Why a dedicated worker: @xenova/transformers runs ONNX inference (WASM or
 * native) on the main thread by default. The intent model
 * (Xenova/distilbert-base-multilingual-cased-finetuned-mnli, ~135MB ONNX)
 * takes ~100-200ms per classification — every cache-missed chat-route
 * request froze the event loop, and every other tenant's request, for the
 * whole inference. Hosting the model in a worker_thread confines the
 * blocking to a dedicated loop, exactly as the cross-encoder reranker
 * (src/ai/cross-encoder/cross-encoder.worker.ts) and the BGE-M3 embedder
 * (src/ai/embedder/bge-m3.worker.ts) do.
 *
 * Protocol: parent posts `{ id, kind, payload }`; worker replies with
 * `{ id, ok, result | error }`. id demuxes concurrent requests.
 */
import { parentPort } from 'node:worker_threads';

interface WorkerConfig {
  modelId: string;
}

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options: { hypothesis_template: string },
) => Promise<{
  sequence: string;
  labels: string[];
  scores: number[];
}>;

type Inbound =
  | { id: number; kind: 'warmup'; payload: WorkerConfig }
  | {
      id: number;
      kind: 'classify';
      payload: { text: string; labels: string[]; hypothesisTemplate: string };
    };

type Outbound =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error('intent-classifier.worker must be run as a worker_thread');
}

let classifier: ZeroShotPipeline | null = null;
let warmupPromise: Promise<void> | null = null;

function reply(msg: Outbound): void {
  parentPort!.postMessage(msg);
}

async function warmup(cfg: WorkerConfig): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string };
      pipeline: (task: string, modelId: string) => Promise<unknown>;
    };
    // transformers.js v2 ignores the python-style TRANSFORMERS_CACHE / HF_HOME
    // env vars — it resolves its own default under node_modules, which is
    // root-owned (and re-downloaded on every restart) in the Docker image.
    // Honour the env explicitly so the operator's cache mount actually works.
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    classifier = (await t.pipeline('zero-shot-classification', cfg.modelId)) as ZeroShotPipeline;
  })();
  return warmupPromise;
}

async function classify(p: {
  text: string;
  labels: string[];
  hypothesisTemplate: string;
}): Promise<{ labels: string[]; scores: number[] }> {
  if (!classifier) throw new Error('NLI classifier not ready');
  const out = await classifier(p.text, p.labels, {
    hypothesis_template: p.hypothesisTemplate,
  });
  return { labels: out.labels, scores: out.scores };
}

const onMessage = async (msg: Inbound): Promise<void> => {
  try {
    if (msg.kind === 'warmup') {
      await warmup(msg.payload);
      reply({ id: msg.id, ok: true, result: { ready: true } });
      return;
    }
    if (warmupPromise) await warmupPromise;
    if (msg.kind === 'classify') {
      reply({ id: msg.id, ok: true, result: await classify(msg.payload) });
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
    console.error(`intent-classifier worker handler crashed: ${(err as Error).message}`);
  });
});
