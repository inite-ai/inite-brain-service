/**
 * Worker thread that owns the BGE-M3 model.
 *
 * Why a dedicated worker: @xenova/transformers' BGE-M3 runs ONNX
 * inference (WASM or native) on the main thread by default. A single
 * 1024-dim embedding burns 20-200ms of CPU; with N concurrent embeds
 * the event loop stops for that whole window, which freezes every
 * other tenant's request. Hosting the model in a worker_thread
 * confines the blocking to a dedicated event loop and lets the main
 * loop keep serving HTTP while inference is in flight.
 *
 * Protocol: parent posts `{ id, kind, payload }`; worker replies with
 * `{ id, ok, result | error }`. id is opaque to the worker — parent
 * uses it to demux concurrent requests.
 *
 * Lifecycle: parent calls `warmup` exactly once on boot. The reply
 * tells parent the worker is ready; until then embed/embedMany RPCs
 * queue inside the worker's message handler (so an early HTTP request
 * can wait without the parent's awareness).
 */
import { parentPort } from 'node:worker_threads';

interface WorkerConfig {
  modelId: string;
  dimensions: number;
}

interface FeatureExtractionPipeline {
  (
    input: string | string[],
    opts?: { pooling?: 'cls' | 'mean'; normalize?: boolean },
  ): Promise<{ data: Float32Array | number[] }>;
}

type Inbound =
  | { id: number; kind: 'warmup'; payload: WorkerConfig }
  | { id: number; kind: 'embed'; payload: { text: string } }
  | { id: number; kind: 'embedMany'; payload: { texts: string[] } };

type Outbound =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

if (!parentPort) {
  throw new Error('bge-m3.worker must be run as a worker_thread');
}

let pipeline: FeatureExtractionPipeline | null = null;
let dimensions = 1024;
let warmupPromise: Promise<void> | null = null;

function reply(msg: Outbound): void {
  parentPort!.postMessage(msg);
}

async function warmup(cfg: WorkerConfig): Promise<void> {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    dimensions = cfg.dimensions;
    const transformers = await import('@xenova/transformers');
    pipeline = (await transformers.pipeline(
      'feature-extraction',
      cfg.modelId,
    )) as unknown as FeatureExtractionPipeline;
  })();
  return warmupPromise;
}

function shapeVector(raw: Iterable<number>): number[] {
  const v = Array.from(raw);
  if (v.length === dimensions) return v;
  if (v.length > dimensions) return v.slice(0, dimensions);
  const padded = new Array(dimensions).fill(0);
  for (let i = 0; i < v.length; i++) padded[i] = v[i];
  return padded;
}

async function embed(text: string): Promise<number[]> {
  if (!pipeline) throw new Error('BGE-M3 pipeline not ready');
  const trimmed = text.trim();
  if (!trimmed) return new Array(dimensions).fill(0);
  const out = await pipeline(trimmed, { pooling: 'cls', normalize: true });
  return shapeVector(out.data as Iterable<number>);
}

async function embedMany(texts: string[]): Promise<number[][]> {
  if (!pipeline) throw new Error('BGE-M3 pipeline not ready');
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    out[i] = await embed(texts[i] ?? '');
  }
  return out;
}

parentPort.on('message', async (msg: Inbound) => {
  try {
    if (msg.kind === 'warmup') {
      await warmup(msg.payload);
      reply({ id: msg.id, ok: true, result: { ready: true } });
      return;
    }
    if (warmupPromise) await warmupPromise;
    if (msg.kind === 'embed') {
      reply({ id: msg.id, ok: true, result: await embed(msg.payload.text) });
      return;
    }
    if (msg.kind === 'embedMany') {
      reply({
        id: msg.id,
        ok: true,
        result: await embedMany(msg.payload.texts),
      });
      return;
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: (e as Error).message });
  }
});
