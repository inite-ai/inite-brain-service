import { Injectable } from '@nestjs/common';
import { evidenceDerivedMaxBytes, evidenceMaxBytes } from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes } from './adapter-io';
import { mailText } from './mail-text';

/**
 * MailTextAdapter — an .eml (`message/rfc822`) reduced to its headers and
 * first text body, attachments named but never read. A mailbox export
 * on a drive is a source like any other; the facts it yields carry the
 * message's own From / Date lines so the extractor sees who said what
 * when, and a fact can name its message.
 *
 * Capability 'text', one media type, zero dependencies (mail-text.ts);
 * bounded by part count and nesting depth. Local, deterministic.
 */
@Injectable()
export class MailTextAdapter implements ProcessorAdapter {
  readonly capability = 'text' as const;
  readonly version = 'document-mail-text-v1';

  configParts(): string[] {
    return [`render=${RENDER_CONTRACT}`];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (modality !== 'document') return false;
    const semi = mediaType.indexOf(';');
    return (semi === -1 ? mediaType : mediaType.slice(0, semi)).trim().toLowerCase() === MAIL_MEDIA_TYPE;
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const content = mailText(bytes);
    if (content.trim().length === 0) throw new Error('message carries no headers and no text body');
    const cap = evidenceDerivedMaxBytes();
    if (Buffer.byteLength(content, 'utf8') > cap) {
      throw new Error(`message text exceeds the derived-output cap (${String(cap)} bytes)`);
    }
    return [{ kind: 'text', content }];
  }
}

const RENDER_CONTRACT = 'headers-body-attachments-v1';
export const MAIL_MEDIA_TYPE = 'message/rfc822';
