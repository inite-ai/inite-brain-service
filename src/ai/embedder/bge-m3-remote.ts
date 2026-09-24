/**
 * BGE-M3 served over HTTP — the same model the local worker runs, from an
 * OpenAI-compatible `/embeddings` endpoint (OpenRouter's `baai/bge-m3` by
 * default).
 *
 * Why a remote runtime for a model we already run locally. Measured on the
 * production droplet (2 vCPU), 2026-09-24: one `ingest_document` took 113 s,
 * and 51 s of it was embeddings — 101 single-text calls started at once,
 * each stretched to 2–35 s queueing behind the others on two cores. The same
 * 100 texts as ONE request to the remote endpoint took 0.8 s from the
 * droplet; a single query embed took 0.2–0.47 s warm, which is the local
 * worker's own figure (0.3–0.43 s). The price is $0.01 per million tokens.
 *
 * Why it is the same space and not a new one. Cosine between the remote
 * vector and the local worker's vector for the same text: 0.985–0.989 over
 * Russian, English and Chinese — the local copy is the q8-quantised
 * Xenova export, the remote one is full precision; the two remote
 * providers OpenRouter routes between return identical vectors (1.0000).
 * Retrieval order with a remote query against local rows is preserved
 * down to a tie in the tail. So the declared space stays
 * `bge-m3:Xenova/bge-m3:1024:l2`; a reindex through this runtime removes
 * the quantisation offset but nothing breaks without one.
 *
 * Coalescing. Callers embed one text at a time and in parallel (the ingest
 * path fans a document's facts out with Promise.all); sending each as its
 * own request would trade CPU queueing for rate limits. Calls that arrive
 * within `windowMs` of each other, up to `maxBatch`, travel as one request,
 * identical texts in it sent once.
 */

export interface RemoteBgeM3Config {
  /** Full URL of the OpenAI-compatible embeddings endpoint. */
  url: string;
  apiKey: string;
  /** Model id at that endpoint (`baai/bge-m3` on OpenRouter). */
  model: string;
  /** The declared width; a response of any other width is refused. */
  dim: number;
  timeoutMs?: number;
  maxBatch?: number;
  windowMs?: number;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

interface Waiter {
  text: string;
  resolve: (v: number[]) => void;
  reject: (e: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BATCH = 96;
const DEFAULT_WINDOW_MS = 8;

export class RemoteBgeM3 {
  private readonly timeoutMs: number;
  private readonly maxBatch: number;
  private readonly windowMs: number;
  private readonly fetchImpl: typeof fetch;
  private queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: RemoteBgeM3Config) {
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBatch = cfg.maxBatch ?? DEFAULT_MAX_BATCH;
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** One text, coalesced with whatever else arrives in the same window. */
  embed(text: string): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      if (this.queue.length >= this.maxBatch) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
        this.timer.unref?.();
      }
    });
  }

  /** Many texts, in `maxBatch` requests sent side by side; order preserved. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      chunks.push(texts.slice(i, i + this.maxBatch));
    }
    const out = await Promise.all(chunks.map((c) => this.request(c)));
    return out.flat();
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.queue.splice(0, this.maxBatch);
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.flush(), 0);
      this.timer.unref?.();
    }
    if (batch.length === 0) return;
    const unique = [...new Set(batch.map((w) => w.text))];
    this.request(unique).then(
      (vectors) => {
        const byText = new Map(unique.map((t, i) => [t, vectors[i]!]));
        for (const w of batch) w.resolve(byText.get(w.text)!);
      },
      (e: unknown) => {
        for (const w of batch) w.reject(e as Error);
      },
    );
  }

  /** One HTTP request; every vector checked before any is handed out. */
  private async request(texts: string[]): Promise<number[][]> {
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`remote bge-m3 answered ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as {
      data?: { index?: number; embedding?: unknown }[];
    };
    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(
        `remote bge-m3 returned ${Array.isArray(data) ? data.length : 'no'} vectors for ${texts.length} texts`,
      );
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => this.checked(d.embedding, i));
  }

  private checked(v: unknown, i: number): number[] {
    if (
      !Array.isArray(v) ||
      v.length !== this.cfg.dim ||
      !v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      throw new Error(
        `remote bge-m3 vector ${i} is not ${this.cfg.dim} finite numbers — refusing a vector outside the declared space`,
      );
    }
    return v as number[];
  }
}
