import sharp from 'sharp';
import type { FragmentLocator } from './locator';
import { runFfmpeg } from './processing/adapters/audio-decode';
import { modalityOf } from './upload-media-types';

/**
 * A fragment's bytes, cut to its locator (#900). A fragment is a PART of an
 * asset — one OCR region of a screenshot, one transcript segment of a
 * recording — and its raw route used to serve the whole parent. That
 * over-shares: a citation to the total on a receipt handed out the whole
 * receipt, the name and card number included. Data minimisation (GDPR
 * art. 5(1)(c)) says serve the part the citation names.
 *
 * What can be cut is decided by the locator kind, one cutter per kind:
 *  - pageRegion on an image (page 0): the region, from the EXIF-oriented
 *    raster — the frame the OCR adapter measured its boxes in — as PNG
 *    (lossless: a region is usually text);
 *  - timeRange on a recording: the span, as 16-bit PCM WAV (decoded and
 *    re-encoded, so it starts on the exact sample, not the nearest
 *    keyframe or packet).
 * Any other pair (a PDF page region, a character range, a video span)
 * has no cutter yet: the caller serves the parent, as before.
 * A cut that fails is an error, never a silent fallback to the whole.
 */

export interface CroppedMedia {
  bytes: Buffer;
  mediaType: string;
  /** The locator kind the bytes were cut to. */
  cut: FragmentLocator['kind'];
}

export interface CropLimits {
  /** Largest cut output accepted. */
  maxBytes: number;
  deadlineMs: number;
}

interface Cutter {
  applies(modality: string | undefined, locator: FragmentLocator): boolean;
  cut(bytes: Buffer, locator: FragmentLocator, limits: CropLimits): Promise<CroppedMedia>;
}

const CUTTERS = new Map<FragmentLocator['kind'], Cutter>([
  [
    'pageRegion',
    {
      applies: (modality, locator) =>
        modality === 'image' && locator.kind === 'pageRegion' && locator.page === 0,
      cut: (bytes, locator) => cutRegion(bytes, locator as RegionLocator),
    },
  ],
  [
    'timeRange',
    {
      applies: (modality) => modality === 'audio',
      cut: (bytes, locator, limits) => cutTime(bytes, locator as TimeLocator, limits),
    },
  ],
]);

type RegionLocator = Extract<FragmentLocator, { kind: 'pageRegion' }>;
type TimeLocator = Extract<FragmentLocator, { kind: 'timeRange' }>;

/** Whether a fragment of this media type and locator can be served as its part. */
export function canCrop(mediaType: string, locator: FragmentLocator | undefined): boolean {
  if (!locator) return false;
  return CUTTERS.get(locator.kind)?.applies(modalityOf(mediaType), locator) ?? false;
}

/** The fragment's part of the parent's bytes, or null when no cutter applies. */
export async function cropFragment(
  bytes: Buffer,
  subject: { mediaType: string; locator?: FragmentLocator | undefined },
  limits: CropLimits,
): Promise<CroppedMedia | null> {
  const { mediaType, locator } = subject;
  if (!locator || !canCrop(mediaType, locator)) return null;
  return CUTTERS.get(locator.kind)!.cut(bytes, locator, limits);
}

/** The pixel box of a normalised region on a W×H raster, at least 1×1 and inside it. */
export function regionBox(
  locator: Pick<RegionLocator, 'x' | 'y' | 'w' | 'h'>,
  size: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const span = (start: number, extent: number, total: number) => {
    const lo = Math.min(total - 1, Math.max(0, Math.floor(start * total)));
    const hi = Math.min(total, Math.max(lo + 1, Math.ceil((start + extent) * total)));
    return [lo, hi - lo] as const;
  };
  const [left, width] = span(locator.x, locator.w, size.width);
  const [top, height] = span(locator.y, locator.h, size.height);
  return { left, top, width, height };
}

async function cutRegion(bytes: Buffer, locator: RegionLocator): Promise<CroppedMedia> {
  const meta = await sharp(bytes, { failOn: 'error' }).metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new Error('the image has no readable size');
  const out = await sharp(bytes, { failOn: 'error' })
    .autoOrient()
    .extract(regionBox(locator, { width, height }))
    .png()
    .toBuffer();
  return { bytes: out, mediaType: 'image/png', cut: 'pageRegion' };
}

async function cutTime(
  bytes: Buffer,
  locator: TimeLocator,
  limits: CropLimits,
): Promise<CroppedMedia> {
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const out = await runFfmpeg(
    [
      '-ss',
      seconds(locator.startMs),
      '-to',
      seconds(locator.endMs),
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
    ],
    bytes,
    {
      maxOutBytes: limits.maxBytes,
      deadlineMs: limits.deadlineMs,
      overflow: 'the cut span is larger than a fragment read returns',
    },
  );
  if (out.byteLength <= WAV_HEADER_BYTES) throw new Error('the span holds no audio');
  return { bytes: out, mediaType: 'audio/wav', cut: 'timeRange' };
}

/** A WAV file with no samples is its 44-byte header alone. */
const WAV_HEADER_BYTES = 44;
