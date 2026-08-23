/**
 * Worker thread that owns the local cross-encoder model.
 *
 * Why a dedicated worker: @xenova/transformers runs ONNX inference (WASM or
 * native) on the main thread by default. The reranker model
 * (Xenova/bge-reranker-base = xlm-roberta-base, ~278M params) scores a
 * (query, document) pair in tens of milliseconds; a 20-document window on
 * the main thread would freeze the event loop — and every other tenant's
 * request — for the whole rerank. Hosting the model in a worker_thread
 * confines the blocking to a dedicated loop, exactly as the BGE-M3 embedder
 * does (src/ai/embedder/bge-m3.worker.ts).
 *
 * Protocol: parent posts `{ id, kind, payload }`; worker replies with
 * `{ id, ok, result | error }`. id demuxes concurrent requests.
 */
import { parentPort } from 'node:worker_threads';

interface WorkerConfig {
  modelId: string;
}

interface Tokenizer {
  (
    query: string,
    opts: { text_pair: string; padding: boolean; truncation: boolean },
  ): Promise<unknown>;
}
interface SeqClassModel {
  (inputs: unknown): Promise<{ logits: { data: Float32Array | number[] } }>;
}

type Inbound =
  | { id: number; kind: 'warmup'; payload: WorkerConfig }
  | {
      id: number;
      kind: 'score';
      payload: { query: string; documents: string[]; deadlineMs?: number };
    };

type Outbound =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error('cross-encoder.worker must be run as a worker_thread');
}

let tokenizer: Tokenizer | null = null;
let model: SeqClassModel | null = null;
let warmupPromise: Promise<void> | null = null;

function reply(msg: Outbound): void {
  parentPort!.postMessage(msg);
}

async function warmup(cfg: WorkerConfig): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string; allowRemoteModels?: boolean };
      AutoTokenizer: { from_pretrained: (id: string) => Promise<Tokenizer> };
      AutoModelForSequenceClassification: {
        from_pretrained: (id: string, opts?: { quantized?: boolean }) => Promise<SeqClassModel>;
      };
    };
    // transformers.js v2 ignores the python-style TRANSFORMERS_CACHE / HF_HOME
    // env vars — it resolves its own default under node_modules, which is
    // root-owned (and re-downloaded on every restart) in the Docker image.
    // Honour the env explicitly so the operator's cache mount actually works.
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    tokenizer = await t.AutoTokenizer.from_pretrained(cfg.modelId);
    model = await t.AutoModelForSequenceClassification.from_pretrained(cfg.modelId, {
      quantized: true,
    });
  })();
  return warmupPromise;
}

async function score(p: {
  query: string;
  documents: string[];
  deadlineMs?: number;
}): Promise<number[]> {
  if (!tokenizer || !model) throw new Error('cross-encoder not ready');
  const deadline = p.deadlineMs && p.deadlineMs > 0 ? Date.now() + p.deadlineMs : undefined;
  const scores: number[] = new Array(p.documents.length).fill(Number.NEGATIVE_INFINITY);
  for (const [i, doc] of p.documents.entries()) {
    // Deadline check between pairs: a slow host must not blow the caller's
    // stage budget. Unscored docs keep -Infinity and sink to the tail (the
    // array length still matches, so the permutation stays valid).
    if (deadline !== undefined && Date.now() > deadline) break;
    const inputs = await tokenizer(p.query, {
      text_pair: doc,
      padding: true,
      truncation: true,
    });
    const out = await model(inputs);
    scores[i] = Number(out.logits.data[0]);
  }
  return scores;
}

const onMessage = async (msg: Inbound): Promise<void> => {
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

// The message listener is void-returning and each message is handled
// independently, so the async work runs detached. onMessage already reports
// business failures to the parent via reply(); the .catch guards only a
// catastrophic reply()/port failure from becoming an unhandledRejection.
parentPort.on('message', (msg: Inbound) => {
  void onMessage(msg).catch((err) => {
    console.error(`cross-encoder worker handler crashed: ${(err as Error).message}`);
  });
});
