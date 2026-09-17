import { Injectable } from '@nestjs/common';
import { evidenceDerivedMaxBytes, evidenceMaxBytes } from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes } from './adapter-io';
import { docxText, pptxText, xlsxText } from './ooxml-text';

/**
 * OfficeTextAdapter — text from the OOXML office documents (Word, Excel,
 * PowerPoint), the third byte-reading processor on the document
 * modality and the one the source plane's folder / bucket connections
 * lean on: a network drive holds .docx and .xlsx next to its PDFs, and a
 * pack cannot read what the plane refuses to open.
 *
 * Same capability ('text') as the PDF and passthrough adapters, disjoint
 * media types — only the three macro-FREE containers. The macro-enabled
 * siblings (.docm / .xlsm / .pptm) stay off the upload allowlist: a
 * container with code in it is a delivery vehicle, and nothing here
 * scans one.
 *
 * ZERO dependencies (zip-reader.ts + ooxml-text.ts): an XML parser would
 * be both a supply-chain surface and an XXE surface; the text of an
 * office document sits in a handful of element names that a bounded
 * scan finds. Every read is fenced — named parts only, an inflate cap
 * per part, a directory cap — so a crafted archive is a failed run,
 * never an OOM. Local, no network, no model; deterministic.
 */
@Injectable()
export class OfficeTextAdapter implements ProcessorAdapter {
  readonly capability = 'text' as const;
  readonly version = 'document-office-text-v1';

  /** The rendering contract (markers, separators) is the only knob that
   *  moves output; bump it and every stored representation re-derives. */
  configParts(): string[] {
    return [`render=${RENDER_CONTRACT}`];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (modality !== 'document') return false;
    return OFFICE_MEDIA_TYPES.has(normaliseMediaType(mediaType));
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const kind = OFFICE_MEDIA_TYPES.get(normaliseMediaType(input.asset.mediaType));
    if (!kind) throw new Error(`not an OOXML media type: ${input.asset.mediaType}`);
    const cap = evidenceDerivedMaxBytes();
    // The inflate cap is the derived cap: a part that cannot fit the
    // output cannot be output, so it never needs to be in memory.
    const limits = { maxPartBytes: cap };
    const content = (kind === 'docx' ? docxText : kind === 'xlsx' ? xlsxText : pptxText)(
      bytes,
      limits,
    );
    if (content.trim().length === 0) {
      throw new Error(`${kind} carries no text — a document of images needs an OCR processor`);
    }
    if (Buffer.byteLength(content, 'utf8') > cap) {
      throw new Error(`extracted text exceeds the derived-output cap (${String(cap)} bytes)`);
    }
    return [{ kind: 'text', content }];
  }
}

const RENDER_CONTRACT = 'ooxml-lines-v1';

export const OFFICE_MEDIA_TYPES: ReadonlyMap<string, 'docx' | 'xlsx' | 'pptx'> = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
]);

function normaliseMediaType(raw: string): string {
  const semi = raw.indexOf(';');
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}
