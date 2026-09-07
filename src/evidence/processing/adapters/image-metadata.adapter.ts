import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { evidenceMaxBytes } from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes, withDeadline } from './adapter-io';
import { EXIF_FACT_ORDER, readAllowlistedExif, type ExifFacts } from './exif-allowlist';

/**
 * ImageMetadataAdapter — the FIRST real (byte-reading) platform processor
 * on the multimodal plane. It replaces ImageMetadataStubAdapter for the
 * 'caption' capability on images: where the stub merely string-formatted
 * the mediaType / WxH / byteLength the CALLER had already declared, this
 * adapter decodes the actual bytes through libvips (sharp — already a
 * pinned dependency, previously imported nowhere) and reports what the
 * file really is.
 *
 * Intrinsic facts read from the bytes: pixel dimensions, container
 * format, colour space, channel count, bit depth, alpha, interlacing,
 * palette, embedded ICC profile, and EXIF orientation. Declared row
 * metadata is NEVER trusted for these — a caller claiming 4000x3000 for a
 * 4x3 GIF is exactly the kind of drift the evidence plane exists to
 * catch, so the rendering reports the DECODED numbers and flags the
 * mismatch.
 *
 * PRIVACY. EXIF is read through a strict allowlist (exif-allowlist.ts):
 * capture timestamp, camera make / model, writing software. GPS is NOT
 * extracted — the GPS IFD pointer is never followed, so coordinates never
 * exist in memory to leak (an image's location block is its most
 * re-identifying field and the plane has no consent surface for it).
 * Free-text EXIF (Artist / Copyright / ImageDescription / UserComment /
 * MakerNote) and device serial numbers are likewise never read; those are
 * where the ingest PiiClass taxonomy's email / phone / number actually
 * live. The rendering states `gps: not extracted (policy)` so the
 * exclusion is auditable from the stored derived content itself.
 *
 * No network, no model, no key — pure local decode. Deterministic: the
 * same bytes always render the same string, byte for byte.
 *
 * BYTE-LESS ASSETS. availability 'external' assets hold only an
 * originUri, so there is nothing to decode. Rather than fail those runs
 * (and rather than keep a second adapter alive for them), the adapter
 * degrades to a row-metadata rendering — the stub's exact job — and says
 * so in a `source:` line, so a reader can always tell a decoded fact from
 * a declared one.
 */
@Injectable()
export class ImageMetadataAdapter implements ProcessorAdapter {
  readonly capability = 'caption' as const;
  readonly version = 'image-metadata-v1';

  /**
   * The EXIF allowlist is the one knob that moves output without moving
   * the code version — extend the list and every existing run's content
   * would silently be stale under the same idempotency key. Riding it in
   * the fingerprint forks the key automatically (#386 discipline).
   */
  configParts(): string[] {
    return [`exif=${EXIF_FACT_ORDER.join(',')}`, 'gps=excluded'];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (modality !== 'image') return false;
    return DECODABLE_MEDIA_TYPES.has(normaliseMediaType(mediaType));
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const { asset } = input;
    if (input.openStream === null) {
      return [{ kind: 'caption', content: renderDeclared(asset) }];
    }
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const decoded = await withDeadline(sharp(bytes, { failOn: 'error' }).metadata(), {
      ms: IMAGE_DECODE_DEADLINE_MS,
      label: 'image metadata decode',
    });
    return [{ kind: 'caption', content: renderDecoded(asset, bytes.byteLength, decoded) }];
  }
}

/**
 * Wall-clock bound on one decode. libvips reads headers only for
 * metadata(), so a legitimate image resolves in single-digit
 * milliseconds; anything near this bound is a crafted file.
 */
const IMAGE_DECODE_DEADLINE_MS = 10_000;

/**
 * Container formats libvips decodes in the standard build. Declining
 * everything else at accepts() time lets the broker record an honest
 * `no installed processor` denial instead of a failed run.
 */
const DECODABLE_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jp2',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
]);

/** `image/JPEG; charset=binary` → `image/jpeg`. */
function normaliseMediaType(mediaType: string): string {
  const semicolon = mediaType.indexOf(';');
  return (semicolon === -1 ? mediaType : mediaType.slice(0, semicolon)).trim().toLowerCase();
}

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

/**
 * Render decoded facts. Line 1 is a human sentence (what the BM25 /
 * fragment lane indexes and a reader skims); the block below is a fixed
 * key-order field list — stable ordering is what makes the output
 * byte-identical across runs, so it is a declared constant, never
 * whatever order the decoder happened to fill the object in.
 */
function renderDecoded(
  asset: ProcessorInput['asset'],
  byteLength: number,
  meta: SharpMetadata,
): string {
  const facts = meta.exif ? readAllowlistedExif(meta.exif) : {};
  const width = meta.width;
  const height = meta.height;
  const dims =
    width !== undefined && height !== undefined ? `${width}x${height} px` : 'unknown size';
  const headline = [
    `${meta.format ?? 'unknown'} image, ${dims}`,
    meta.space === undefined ? null : `${meta.space} colour`,
    meta.channels === undefined ? null : `${String(meta.channels)} channels`,
    meta.hasAlpha === true ? 'with alpha' : 'opaque',
    `${String(byteLength)} bytes`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  const fields: Array<[string, string | undefined]> = [
    ['source', 'decoded bytes'],
    ['format', meta.format],
    ['mediaType', asset.mediaType],
    ['width', numberOrUndefined(width)],
    ['height', numberOrUndefined(height)],
    ['colourSpace', meta.space],
    ['channels', numberOrUndefined(meta.channels)],
    ['depth', meta.depth],
    ['hasAlpha', boolOrUndefined(meta.hasAlpha)],
    ['isProgressive', boolOrUndefined(meta.isProgressive)],
    ['isPalette', boolOrUndefined(meta.isPalette)],
    ['hasIccProfile', boolOrUndefined(meta.hasProfile)],
    ['orientation', numberOrUndefined(meta.orientation)],
    ['byteLength', String(byteLength)],
    ...exifFields(facts),
    ['gps', 'not extracted (policy)'],
    ['declaredMismatch', declaredMismatch(asset, { byteLength, width, height })],
  ];
  return [headline, '', ...renderFields(fields)].join('\n');
}

/** The byte-less path: everything we can honestly say from the row. */
function renderDeclared(asset: ProcessorInput['asset']): string {
  const dims =
    asset.width !== undefined && asset.height !== undefined
      ? `${String(asset.width)}x${String(asset.height)} px`
      : 'unknown size';
  const headline = `${asset.mediaType} image (not decoded), ${dims}, ${String(asset.byteLength)} bytes`;
  return [
    headline,
    '',
    ...renderFields([
      ['source', `row metadata (availability '${asset.availability}')`],
      ['mediaType', asset.mediaType],
      ['width', numberOrUndefined(asset.width)],
      ['height', numberOrUndefined(asset.height)],
      ['byteLength', String(asset.byteLength)],
      ['gps', 'not extracted (policy)'],
    ]),
  ].join('\n');
}

/** EXIF facts in the declared order — the same list the fingerprint rides. */
function exifFields(facts: ExifFacts): Array<[string, string | undefined]> {
  return EXIF_FACT_ORDER.map((key) => [`exif.${key}`, facts[key]] as [string, string | undefined]);
}

/**
 * A decoded dimension or size that contradicts what the caller declared
 * is a provenance signal, so it is stated rather than silently corrected.
 * `null`/absent declared values are simply not compared.
 */
function declaredMismatch(
  asset: ProcessorInput['asset'],
  decoded: { byteLength: number; width: number | undefined; height: number | undefined },
): string | undefined {
  const { byteLength, width, height } = decoded;
  const parts: string[] = [];
  if (asset.width !== undefined && width !== undefined && asset.width !== width) {
    parts.push(`width declared ${String(asset.width)}, decoded ${String(width)}`);
  }
  if (asset.height !== undefined && height !== undefined && asset.height !== height) {
    parts.push(`height declared ${String(asset.height)}, decoded ${String(height)}`);
  }
  if (asset.byteLength !== byteLength) {
    parts.push(`byteLength declared ${String(asset.byteLength)}, read ${String(byteLength)}`);
  }
  return parts.length === 0 ? undefined : parts.join('; ');
}

/** Drop absent fields entirely — an empty `key:` line carries no signal. */
function renderFields(fields: Array<[string, string | undefined]>): string[] {
  return fields
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
}

function numberOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function boolOrUndefined(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
