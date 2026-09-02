import { Injectable } from '@nestjs/common';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';

/**
 * Image metadata stub (0121): a deterministic 'image' → 'caption'
 * processor that captions from ROW METADATA ONLY — it never opens the
 * byte stream, so it works for availability 'external' assets too (the
 * brain holds only an originUri for those). A real vision captioner is a
 * paid-model follow-up behind its own key; this stub exists so the
 * broker's image path is exercised end-to-end without one.
 */
@Injectable()
export class ImageMetadataStubAdapter implements ProcessorAdapter {
  readonly capability = 'caption' as const;
  readonly version = 'image-metadata-stub-v1';

  /** No knobs beyond cap|ver — output is a pure function of row metadata. */
  configParts(): string[] {
    return [];
  }

  accepts(modality: EvidenceModality, _mediaType: string): boolean {
    return modality === 'image';
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const { mediaType, width, height, byteLength } = input.asset;
    const dims =
      width !== undefined && height !== undefined ? ` ${String(width)}x${String(height)}` : '';
    return Promise.resolve([
      { kind: 'caption', content: `image ${mediaType}${dims} ${String(byteLength)} bytes` },
    ]);
  }
}
