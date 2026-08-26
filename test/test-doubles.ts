import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { ExtractorService, ExtractionResult } from '../src/ai/extractor.service';
import type { LocalCrossEncoderProvider } from '../src/ai/cross-encoder/local-cross-encoder.provider';
import { SynthesizeService } from '../src/synthesize/synthesize.service';
import { SceneEnricherService } from '../src/admin/scene-enricher.service';

/**
 * Deterministic embedder stub for e2e tests. Same text → same vector;
 * different text → mostly different vector (normalized hash bytes).
 *
 * For "is X close to Y" assertions in tests, we exploit text equality:
 * identical text → cosine 1.0; different text → cosine ~0.
 */
export class StubEmbedder implements Pick<
  EmbedderService,
  'embed' | 'embedMany' | 'getDimensions' | 'primarySpaceId' | 'activeSpaceId'
> {
  constructor(private readonly dimensions = 1536) {}

  // Tier 2: the canonical space of the stub's vectors. The stub emulates the
  // default OpenAI 1536-dim provider, so EmbeddingSpaceService's resolver /
  // reindex stamp see a coherent `openai:...:l2` descriptor in e2e.
  primarySpaceId(): string {
    return `openai:text-embedding-3-small:${this.dimensions}:l2`;
  }

  activeSpaceId(): string {
    return this.primarySpaceId();
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.dimensions).fill(0);
    return hashToVector(trimmed, this.dimensions);
  }

  // Tracks the batched API added to EmbedderService alongside embed().
  // ReindexEmbeddingsService + PredicateRegistryService both route
  // through it now, so the stub MUST cover both surfaces or those
  // call sites silently fall through to a fallback / failure branch
  // in tests.
  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  getDimensions(): number {
    return this.dimensions;
  }
}

/**
 * Scripted extractor for tests. The default behavior pulls a single
 * "topic" entity from the literal text. Tests that need specific
 * extraction results call setScript() before exercising ingest-mention.
 */
export class StubExtractor implements Pick<
  ExtractorService,
  'extract' | 'modelId' | 'vocabularyVersionHash'
> {
  private script: ExtractionResult | null = null;

  setScript(result: ExtractionResult | null) {
    this.script = result;
  }

  modelId(): string {
    return 'stub-extractor';
  }

  // Recorded on indexer_run rows by the document pipeline.
  async vocabularyVersionHash(_companyId: string): Promise<string | undefined> {
    return 'stub-vocab';
  }

  async extract(text: string, _companyId?: string): Promise<ExtractionResult> {
    if (this.script) return this.script;
    if (!text.trim()) return { entities: [], facts: [], edges: [] };
    return {
      entities: [{ name: text.trim().slice(0, 40), type: 'topic' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'said',
          object: text.trim(),
          confidence: 0.6,
        },
      ],
      edges: [],
    };
  }
}

/**
 * Inert local cross-encoder for e2e — the third member of the fixture's
 * stub set, next to StubEmbedder and StubExtractor, and for the same
 * reason: the real provider loads a model.
 *
 * The real LocalCrossEncoderProvider spawns a worker_thread per app boot
 * and loads `Xenova/bge-reranker-base` (xlm-roberta-base, ~279MB ONNX)
 * through onnxruntime-node. In production that is paid once per process;
 * in e2e it is paid on EVERY `createApp()` — measured at 85 worker
 * threads across one full run — and torn down seconds later by
 * `app.close()`. Both CI failure modes traced back to that (see the
 * measurement note in test/jest-e2e.json).
 *
 * Behaviour is deliberately the SAME branch the real provider takes
 * while its model is still loading, which is what e2e observed anyway:
 * `isReady()` false and `score()` empty, so `CrossEncoderService.
 * rerankLocal` sees a length mismatch and returns the identity
 * permutation. `isLocalOnly()` / `isEnabled()` stay true, so the rerank
 * stage is still entered and still emits its metrics — only the model
 * load disappears. The provider's own logic is covered by
 * test/local-cross-encoder.unit-spec.ts and test/cross-encoder.unit-spec.ts.
 */
export class StubLocalCrossEncoder implements Pick<
  LocalCrossEncoderProvider,
  'modelId' | 'isReady' | 'warmup' | 'score' | 'terminate'
> {
  readonly modelId = 'stub-cross-encoder';

  isReady(): boolean {
    return false;
  }

  async warmup(): Promise<void> {
    // No model, no worker thread, no ONNX session.
  }

  async score(): Promise<number[]> {
    return [];
  }

  async terminate(): Promise<void> {
    // Nothing to tear down.
  }
}

/**
 * Tracking record for `mockSynthesizeOpenAi` — exposes the prompts
 * the SynthesizeService sent into the (mocked) generator + verifier,
 * so e2e tests can assert that, e.g., the Phase 4.C answerLang
 * instruction made it into the user message.
 */
export interface OpenAiMockState {
  calls: Array<{
    system: string;
    user: string;
    response: string;
    /** The full raw request payload (messages + response_format + params)
     *  — lets byte-identity tests pin the prompt AND the JSON schema the
     *  service actually sent (e.g. the L3 evidence-citations flag-off
     *  pin). */
    request: unknown;
  }>;
}

/**
 * Replace the OpenAI client on the running SynthesizeService with a
 * scripted stub. Each call drains one response from `responses`; the
 * last response is repeated indefinitely once the queue is empty (the
 * synthesize flow may emit verifier prompts after the generator).
 *
 * Returns the mock state so the caller can introspect captured
 * messages after `/v1/synthesize` returns.
 */
export function mockSynthesizeOpenAi(app: INestApplication, responses: string[]): OpenAiMockState {
  const state: OpenAiMockState = { calls: [] };
  const svc = app.get(SynthesizeService);
  const stub = {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
          const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
          const idx = state.calls.length;
          const content = responses[idx] ?? responses[responses.length - 1] ?? '{}';
          state.calls.push({ system, user, response: content, request: req });
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  (svc as unknown as { openai: typeof stub }).openai = stub;
  return state;
}

/**
 * Replace the OpenAI client on the running SceneEnricherService with a
 * scripted stub — the same seam as `mockSynthesizeOpenAi` (the enricher's
 * `openai` field is the one admin-side LLM surface of the Brain v2 scene
 * pass). Each call drains one response; the last repeats indefinitely, so
 * a multi-scene pass can share a single scripted reply. NO paid call is
 * ever made.
 */
export function mockSceneEnricherOpenAi(
  app: INestApplication,
  responses: string[],
): OpenAiMockState {
  const state: OpenAiMockState = { calls: [] };
  const svc = app.get(SceneEnricherService);
  const stub = {
    chat: {
      completions: {
        create: async (req: { messages: Array<{ role: string; content: string }> }) => {
          const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
          const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
          const idx = state.calls.length;
          const content = responses[idx] ?? responses[responses.length - 1] ?? '{}';
          state.calls.push({ system, user, response: content, request: req });
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  (svc as unknown as { openai: typeof stub }).openai = stub;
  return state;
}

function hashToVector(text: string, dim: number): number[] {
  // Generate enough bytes by chained sha256.
  const bytesNeeded = dim * 4; // 4 bytes per float
  const chunks: Buffer[] = [];
  let seed = createHash('sha256').update(text).digest();
  let acc = 0;
  while (acc < bytesNeeded) {
    chunks.push(seed);
    acc += seed.length;
    seed = createHash('sha256').update(seed).digest();
  }
  const buf = Buffer.concat(chunks).subarray(0, bytesNeeded);
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    // Read 4 bytes as int32, scale to [-1, 1).
    const v = buf.readInt32BE(i * 4);
    out[i] = v / 0x80000000;
  }
  // Normalize for cosine-friendliness.
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] = out[i]! / norm;
  return out;
}
