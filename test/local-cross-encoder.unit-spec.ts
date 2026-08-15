/**
 * Local cross-encoder fallback — the no-Cohere-key rerank path.
 *
 * Exercises the fallback SELECTION + permutation logic in CrossEncoderService
 * with a stub provider (no model download). The real ONNX inference of
 * LocalCrossEncoderProvider (Xenova/bge-reranker-base) is validated out of band;
 * here we prove the wiring: when Cohere isn't configured and a local provider
 * is wired, scores flow through and produce a descending-relevance permutation.
 */
import { ConfigService } from '@nestjs/config';
import { CrossEncoderService } from '../src/ai/cross-encoder.service';
import type { LocalCrossEncoderProvider } from '../src/ai/cross-encoder/local-cross-encoder.provider';

function cfg(map: Record<string, string> = {}): ConfigService {
  return {
    get: (k: string, d?: string) => (k in map ? map[k] : d),
  } as unknown as ConfigService;
}

function stubLocal(scores: number[]): LocalCrossEncoderProvider {
  return {
    modelId: 'stub',
    isReady: () => true,
    warmup: async () => undefined,
    score: async () => scores,
  } as unknown as LocalCrossEncoderProvider;
}

const cands = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `c${i}`, body: '' }));

describe('CrossEncoderService — local fallback', () => {
  it('isEnabled() is TRUE with no Cohere and a wired provider (capability)', () => {
    // Audit W4 #16: the local encoder is the 2026-08 engine default —
    // no vendor key, own worker thread, and reranking is the field's
    // biggest measured lever.
    const s = new CrossEncoderService(cfg({}), stubLocal([]));
    expect(s.isEnabled()).toBe(true);
  });

  it('isEnabled() is false when no provider is wired and no key set', () => {
    const s = new CrossEncoderService(cfg({}));
    expect(s.isEnabled()).toBe(false);
  });

  it('ranks candidates by local score, descending', async () => {
    const s = new CrossEncoderService(cfg({}), stubLocal([0.1, 5.0, -2.0]));
    expect(await s.rerank('q', cands(3))).toEqual([1, 0, 2]);
  });

  it('falls back to identity when the local score count mismatches', async () => {
    const s = new CrossEncoderService(
      cfg({}),
      stubLocal([1.0]), // 1 score for 2 candidates
    );
    expect(await s.rerank('q', cands(2))).toEqual([0, 1]);
  });

  it('keeps identity for ≤1 candidate / empty query', async () => {
    const s = new CrossEncoderService(cfg({}), stubLocal([5]));
    expect(await s.rerank('q', cands(1))).toEqual([0]);
    expect(await s.rerank('  ', cands(2))).toEqual([0, 1]);
  });

  it('isLocalOnly() reflects the active path', () => {
    // No Cohere → local path is active.
    expect(
      new CrossEncoderService(cfg({}), stubLocal([])).isLocalOnly(),
    ).toBe(true);
    // Cohere configured → local is NOT the active path.
    expect(
      new CrossEncoderService(
        cfg({ COHERE_API_KEY: 'k' }),
        stubLocal([]),
      ).isLocalOnly(),
    ).toBe(false);
  });

  it('ranks deadline-unscored (-Infinity) docs last, stably', async () => {
    // The worker fills docs it couldn't score before the deadline with
    // -Infinity; the comparator must keep a valid, stable permutation.
    const s = new CrossEncoderService(
      cfg({}),
      stubLocal([2.0, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 3.0]),
    );
    // scored: idx3 (3.0) > idx0 (2.0); unscored idx1, idx2 tail in order.
    expect(await s.rerank('q', cands(4))).toEqual([3, 0, 1, 2]);
  });
});
