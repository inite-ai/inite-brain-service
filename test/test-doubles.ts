import { createHash } from 'node:crypto';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { ExtractorService, ExtractionResult } from '../src/ai/extractor.service';

/**
 * Deterministic embedder stub for e2e tests. Same text → same vector;
 * different text → mostly different vector (normalized hash bytes).
 *
 * For "is X close to Y" assertions in tests, we exploit text equality:
 * identical text → cosine 1.0; different text → cosine ~0.
 */
export class StubEmbedder implements Pick<EmbedderService, 'embed' | 'getDimensions'> {
  constructor(private readonly dimensions = 1536) {}

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.dimensions).fill(0);
    return hashToVector(trimmed, this.dimensions);
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
export class StubExtractor implements Pick<ExtractorService, 'extract'> {
  private script: ExtractionResult | null = null;

  setScript(result: ExtractionResult | null) {
    this.script = result;
  }

  async extract(
    text: string,
    _companyId?: string,
  ): Promise<ExtractionResult> {
    if (this.script) return this.script;
    if (!text.trim()) return { entities: [], facts: [] };
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
    };
  }
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
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}
