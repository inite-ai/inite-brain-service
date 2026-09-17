import type { EvidenceModality } from '../../common/evidence-taxonomy';

/**
 * What the file-walking natives (fs, s3) admit, by extension — ONE table
 * so a folder and a bucket read the same things the same way. Text
 * extensions enter the document door as text; binary extensions are
 * handed to the evidence plane under the modality named here, and the
 * plane's processors (PDF, OOXML, mail, image metadata, OCR) turn them
 * into text the bridge carries to facts. Anything not listed is skipped
 * at enumerate time — a connection reads a domain, not a disk.
 */

export const TEXT_EXTENSIONS = [
  'md', 'markdown', 'txt', 'text', 'rst', 'adoc', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'html', 'htm', 'xml', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'sql', 'graphql', 'proto',
];

/** Binary extensions with the evidence modality each one enters under. */
export const BINARY_MODALITIES: Record<string, EvidenceModality> = {
  pdf: 'document',
  docx: 'document',
  xlsx: 'document',
  pptx: 'document',
  eml: 'document',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
};

export const BINARY_EXTENSIONS = Object.keys(BINARY_MODALITIES);

export const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', text: 'text/plain',
  rst: 'text/plain', adoc: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain',
  ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', html: 'text/html', htm: 'text/html',
  xml: 'text/xml', log: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};

export function mediaTypeOf(ext: string): string {
  return MEDIA_TYPES[ext] ?? 'application/octet-stream';
}

/** The modality a binary extension enters the evidence plane under. */
export function modalityOf(ext: string): EvidenceModality {
  return BINARY_MODALITIES[ext] ?? 'image';
}

export const HTML_EXTENSIONS = new Set(['html', 'htm']);

/** The modality a served media type enters the evidence plane under. */
export function modalityOfMediaType(mediaType: string): EvidenceModality {
  const semi = mediaType.indexOf(';');
  const t = (semi === -1 ? mediaType : mediaType.slice(0, semi)).trim().toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'document';
}
