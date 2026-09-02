import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { evidenceDerivedMaxBytes } from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';

/**
 * Text-extraction passthrough (0121): the trivial 'document' → 'text'
 * processor — reads the stored bytes of a plain-text document asset and
 * emits them verbatim as ONE derived 'text' representation. Deterministic
 * and network-free by construction (the point of shipping it first: it
 * exercises the whole broker/run/lineage machinery without a paid model).
 * Real OCR/ASR/vision adapters are follow-ups behind their own keys.
 *
 * The read is bounded by EVIDENCE_DERIVED_MAX_BYTES — a document larger
 * than the derived-output cap could never yield an in-cap output, so the
 * adapter aborts the read instead of buffering it (reject, never
 * truncate: silent truncation would alter derived content).
 */
@Injectable()
export class TextExtractionPassthroughAdapter implements ProcessorAdapter {
  readonly capability = 'text' as const;
  readonly version = 'text-extraction-passthrough-v1';

  /** No knobs beyond cap|ver — the cap failure mode is a run error, not
   *  a silent output change, so it must NOT fork the idempotency key. */
  configParts(): string[] {
    return [];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (modality !== 'document') return false;
    const lower = mediaType.toLowerCase();
    return lower.startsWith('text/') || lower === 'application/json';
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    if (input.openStream === null) {
      throw new Error(
        'asset bytes are not hot — text extraction needs an adapter-stored blob ' +
          "(availability 'hot' with a registered storageRef scheme)",
      );
    }
    const cap = evidenceDerivedMaxBytes();
    const stream = await input.openStream();
    const bytes = await readBounded(stream, cap);
    return [{ kind: 'text', content: bytes.toString('utf8') }];
  }
}

/** Accumulate a stream, aborting as soon as the byte count passes cap. */
async function readBounded(stream: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.byteLength;
    if (total > cap) {
      stream.destroy();
      throw new Error(`asset bytes exceed the derived-output cap (${cap} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
