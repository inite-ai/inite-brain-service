import type { PackSourceShape } from '../../ai/domain-packs/manifest';
import { BINARY_EXTENSIONS, MEDIA_TYPES, TEXT_EXTENSIONS, mediaTypeOf } from './media';

/**
 * What a cloud drive's file is to a connection — the same extension
 * table as fs / s3 (media.ts) applied to a NAME plus the media type the
 * drive reports, so a folder, a bucket and a drive admit the same
 * things. A file with no usable extension is judged by its media type
 * (text/* and JSON are text; PDF / OOXML / images are binary).
 */
export interface CloudFileClass {
  /** The extension the media table knows it by ('' when judged by type alone). */
  ext: string;
  mediaType: string;
  /** Whether this connection's shape takes it. */
  admit: boolean;
}

const EXT_OF_MEDIA_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([ext, mt]) => [mt, ext]),
);

export function extOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/** The connection's own extension list, else the shape's default table. */
export function admittedExtensions(
  shape: PackSourceShape,
  declared: string[] | undefined,
): Set<string> {
  const own = declared?.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0);
  if (own && own.length > 0) return new Set(own);
  return new Set(shape === 'binary' ? BINARY_EXTENSIONS : TEXT_EXTENSIONS);
}

/** The media type a cloud file is served as, by the table (name first, reported type second). */
export function cloudMediaType(name: string, mediaType: string | null | undefined): string {
  return classifyCloudFile({ name, mediaType, shape: 'document', extensions: new Set() }).mediaType;
}

export function classifyCloudFile(p: {
  name: string;
  mediaType: string | null | undefined;
  shape: PackSourceShape;
  extensions: Set<string>;
}): CloudFileClass {
  const bare = (p.mediaType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  let ext = extOfName(p.name);
  if (!(ext in MEDIA_TYPES)) ext = EXT_OF_MEDIA_TYPE[bare] ?? ext;
  const mediaType = ext in MEDIA_TYPES ? mediaTypeOf(ext) : bare || 'application/octet-stream';
  const textByType = bare.startsWith('text/') || bare === 'application/json';
  const admit = p.extensions.has(ext) || (ext === '' && p.shape !== 'binary' && textByType);
  return { ext, mediaType, admit };
}

/** What one connection admits: its shape's table (or its own list) and its byte cap. */
export interface AdmitGate {
  shape: PackSourceShape;
  extensions: Set<string>;
  maxBytes: number;
}

/** The verdict on one file by name, reported type and size. */
export function admitCloudFile(
  f: { name: string; mediaType?: string | null | undefined; size?: number | undefined },
  gate: AdmitGate,
): 'admit' | 'skip' | 'large' {
  const cls = classifyCloudFile({
    name: f.name,
    mediaType: f.mediaType,
    shape: gate.shape,
    extensions: gate.extensions,
  });
  if (!cls.admit) return 'skip';
  return (f.size ?? 0) > gate.maxBytes ? 'large' : 'admit';
}
