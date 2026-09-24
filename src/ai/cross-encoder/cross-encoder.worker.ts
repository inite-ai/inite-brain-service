/**
 * Worker thread that owns the local cross-encoder model.
 *
 * Why a dedicated worker: @xenova/transformers runs ONNX inference (WASM or
 * native) on the main thread by default. The reranker model
 * (Xenova/bge-reranker-base = xlm-roberta-base, ~278M params) scores a
 * (query, document) pair in tens to hundreds of milliseconds; a 20-document
 * window on the main thread would freeze the event loop — and every other
 * tenant's request — for the whole rerank. Hosting the model in a
 * worker_thread confines the blocking to a dedicated loop, exactly as the
 * BGE-M3 embedder does (src/ai/embedder/bge-m3.worker.ts).
 *
 * Requests are served ONE AT A TIME, in arrival order. Inference yields to
 * the worker's event loop between forward passes, so two score requests
 * handled "concurrently" used to interleave pair by pair — each took twice
 * as long and both blew their deadline. A request whose deadline has
 * passed while it waited in the queue is answered without a forward pass:
 * the caller's stage timer has already fallen back, and scoring for it
 * would only delay the request behind it.
 *
 * Protocol: parent posts `{ id, kind, payload }`; worker replies with
 * `{ id, ok, result | error }`. id demuxes concurrent requests.
 */
import { parentPort } from 'node:worker_threads';
import { scorePairs, type PairScorer } from './score-pairs';

interface WorkerConfig {
  modelId: string;
}

type Inbound =
  | { id: number; kind: 'warmup'; payload: WorkerConfig }
  | {
      id: number;
      kind: 'score';
      payload: { query: string; documents: string[]; deadlineAt?: number };
    };

type Outbound =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error('cross-encoder.worker must be run as a worker_thread');
}

let scorer: PairScorer | null = null;
let warmupPromise: Promise<void> | null = null;
/** The serial queue: every message handler is chained behind the previous one. */
let queue: Promise<void> = Promise.resolve();

function reply(msg: Outbound): void {
  parentPort!.postMessage(msg);
}

async function warmup(cfg: WorkerConfig): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string; allowRemoteModels?: boolean };
      AutoTokenizer: { from_pretrained: (id: string) => Promise<PairScorer['tokenizer']> };
      AutoModelForSequenceClassification: {
        from_pretrained: (
          id: string,
          opts?: { quantized?: boolean },
        ) => Promise<PairScorer['model']>;
      };
    };
    // transformers.js v2 ignores the python-style TRANSFORMERS_CACHE / HF_HOME
    // env vars — it resolves its own default under node_modules, which is
    // root-owned (and re-downloaded on every restart) in the Docker image.
    // Honour the env explicitly so the operator's cache mount actually works.
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    const tokenizer = await t.AutoTokenizer.from_pretrained(cfg.modelId);
    const model = await t.AutoModelForSequenceClassification.from_pretrained(cfg.modelId, {
      quantized: true,
    });
    const loaded: PairScorer = { tokenizer, model };
    // One forward pass now, so the first real request does not pay the
    // session's lazy initialisation inside its stage budget.
    await scorePairs(loaded, { query: 'warmup', documents: ['warmup'] });
    scorer = loaded;
  })();
  return warmupPromise;
}

async function score(p: {
  query: string;
  documents: string[];
  deadlineAt?: number;
}): Promise<number[]> {
  if (!scorer) throw new Error('cross-encoder not ready');
  return scorePairs(scorer, p);
}

const handle = async (msg: Inbound): Promise<void> => {
  try {
    if (msg.kind === 'warmup') {
      await warmup(msg.payload);
      reply({ id: msg.id, ok: true, result: { ready: true } });
      return;
    }
    if (warmupPromise) await warmupPromise;
    if (msg.kind === 'score') {
      reply({ id: msg.id, ok: true, result: await score(msg.payload) });
      return;
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: (e as Error).message });
  }
};

// handle() already reports business failures to the parent via reply();
// the .catch guards only a catastrophic reply()/port failure from becoming
// an unhandledRejection and from wedging the queue.
parentPort.on('message', (msg: Inbound) => {
  queue = queue.then(() =>
    handle(msg).catch((err) => {
      console.error(`cross-encoder worker handler crashed: ${(err as Error).message}`);
    }),
  );
});
