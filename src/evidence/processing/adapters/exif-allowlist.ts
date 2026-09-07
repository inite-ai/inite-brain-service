/**
 * Allowlist EXIF reader (Brain v2.1 MM — real image-metadata processor).
 *
 * A deliberately TINY, dependency-free TIFF/IFD walker that reads ONLY
 * the handful of intrinsic-provenance tags the evidence plane is willing
 * to carry into derived content. It is an allowlist by construction, not
 * a full parser with a filter bolted on afterwards — the difference
 * matters for the privacy story:
 *
 *   * The GPS IFD pointer (tag 0x8825) is NEVER followed. Location bytes
 *     are not parsed, never exist as coordinates in memory, and so cannot
 *     leak into a derived_representation through a rendering bug. A phone
 *     photo's GPS block is the most re-identifying field it carries
 *     (sub-metre home addresses) and the evidence plane has no consent
 *     surface for it, so the answer is "we never look", not "we look and
 *     then drop".
 *   * Free-text tags that carry arbitrary human input — Artist (0x013B),
 *     Copyright (0x8298), ImageDescription (0x010E), UserComment
 *     (0x9286), MakerNote (0x927C) — are likewise never read. Those are
 *     where names, emails and phone numbers actually live in the wild
 *     (the ingest PiiClass taxonomy: email / phone / number).
 *   * Device serial numbers (BodySerialNumber 0xA431, LensSerialNumber
 *     0xA435) are not read: a serial pins every photo in a corpus to ONE
 *     physical camera, a durable cross-asset identifier.
 *
 * What IS read: capture timestamp, camera make / model, and the writing
 * software — provenance about the OBSERVATION (useful for temporal
 * grounding and tamper signals), none of it a personal identifier.
 *
 * Only ASCII (TIFF type 2) values are decoded, so the walker can never be
 * steered into interpreting attacker-chosen binary; every offset is
 * bounds-checked and the entry count is capped, so a hostile EXIF blob
 * yields an empty result rather than a throw or a hang. Values are
 * sanitised (control characters stripped, whitespace collapsed) and an
 * implausibly long value is DROPPED rather than clipped — untrusted
 * third-party metadata that does not look like a camera string is not
 * worth carrying.
 */

/** TIFF field type 2 — NUL-terminated ASCII. The only type we decode. */
const TIFF_TYPE_ASCII = 2;
/** An IFD entry is a fixed 12 bytes: tag(2) type(2) count(4) value(4). */
const IFD_ENTRY_BYTES = 12;
/** Refuse absurd directories rather than walking them (hostile input). */
const MAX_IFD_ENTRIES = 512;
/** Longest value we are willing to carry; longer ⇒ the field is dropped. */
const MAX_VALUE_CHARS = 96;

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
/*
 * Spelled out so the omission is greppable and obviously deliberate:
 * 0x8825 is the GPS IFD pointer. Nothing in this file follows it, and no
 * constant for it exists.
 */

/** The allowlisted facts. */
export interface ExifFacts {
  /** DateTimeOriginal, else IFD0 DateTime, normalised to ISO-like local. */
  capturedAt?: string;
  make?: string;
  model?: string;
  software?: string;
}

/**
 * Field order for rendering AND for the config fingerprint — editing this
 * list changes derived output, so the image adapter rides it in
 * configParts() (the #386 discipline: a knob that moves output must move
 * the idempotency key even when nobody remembers to bump the version).
 */
export const EXIF_FACT_ORDER = ['capturedAt', 'make', 'model', 'software'] as const;

interface Cursor {
  buf: Buffer;
  /** Offset of the TIFF header; all IFD offsets are relative to it. */
  base: number;
  littleEndian: boolean;
}

/**
 * Read the allowlisted facts out of a raw EXIF blob (sharp's
 * `metadata().exif`: the APP1 payload, usually prefixed with `Exif\0\0`).
 * Never throws — a malformed blob yields `{}`.
 */
export function readAllowlistedExif(exif: Buffer): ExifFacts {
  try {
    const cursor = openTiff(exif);
    if (!cursor) return {};
    const ifd0Offset = readU32(cursor, cursor.base + 4);
    if (ifd0Offset === null) return {};
    const facts: ExifFacts = {};
    assign(
      facts,
      walkIfd(cursor, cursor.base + ifd0Offset, {
        [TAG_MAKE]: 'make',
        [TAG_MODEL]: 'model',
        [TAG_SOFTWARE]: 'software',
        [TAG_DATETIME]: 'capturedAt',
      }),
    );
    // ONE level deeper, ONLY the Exif sub-IFD (never the GPS pointer).
    const exifIfd = pointerOf(cursor, cursor.base + ifd0Offset, TAG_EXIF_IFD_POINTER);
    if (exifIfd !== null) {
      // DateTimeOriginal (when the shutter fired) beats IFD0 DateTime
      // (when the file was last written), so it overwrites.
      assign(
        facts,
        walkIfd(cursor, cursor.base + exifIfd, { [TAG_DATETIME_ORIGINAL]: 'capturedAt' }),
      );
    }
    if (facts.capturedAt !== undefined) {
      const iso = normaliseExifDate(facts.capturedAt);
      if (iso === null) delete facts.capturedAt;
      else facts.capturedAt = iso;
    }
    return facts;
  } catch {
    // Defence in depth: every read below is already bounds-checked, but a
    // metadata reader must never be the thing that fails a run.
    return {};
  }
}

/** Locate the TIFF header and its byte order; null when absent. */
function openTiff(exif: Buffer): Cursor | null {
  // libvips hands back the whole APP1 payload including the marker.
  const base = exif.subarray(0, 6).toString('latin1') === 'Exif\u0000\u0000' ? 6 : 0;
  if (exif.byteLength < base + 8) return null;
  const order = exif.toString('latin1', base, base + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const cursor: Cursor = { buf: exif, base, littleEndian: order === 'II' };
  // Magic 42 confirms the byte order was read the right way round.
  if (readU16(cursor, base + 2) !== 42) return null;
  return cursor;
}

/** Walk one IFD, collecting the allowlisted tags it carries. */
function walkIfd(cursor: Cursor, at: number, wanted: Record<number, keyof ExifFacts>): ExifFacts {
  const count = readU16(cursor, at);
  if (count === null || count === 0 || count > MAX_IFD_ENTRIES) return {};
  const out: ExifFacts = {};
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * IFD_ENTRY_BYTES;
    const tag = readU16(cursor, entry);
    if (tag === null) return out;
    const field = wanted[tag];
    if (field === undefined) continue;
    const value = readAsciiValue(cursor, entry);
    if (value !== null) out[field] = value;
  }
  return out;
}

/** The sub-IFD offset carried by `tag`, or null when absent/unusable. */
function pointerOf(cursor: Cursor, at: number, tag: number): number | null {
  const count = readU16(cursor, at);
  if (count === null || count === 0 || count > MAX_IFD_ENTRIES) return null;
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * IFD_ENTRY_BYTES;
    if (readU16(cursor, entry) !== tag) continue;
    const offset = readU32(cursor, entry + 8);
    if (offset === null || offset === 0) return null;
    return offset;
  }
  return null;
}

/** Decode one IFD entry as a sanitised ASCII string; null when it is not
 *  ASCII, is out of bounds, or does not survive sanitisation. */
function readAsciiValue(cursor: Cursor, entry: number): string | null {
  if (readU16(cursor, entry + 2) !== TIFF_TYPE_ASCII) return null;
  const count = readU32(cursor, entry + 4);
  if (count === null || count === 0) return null;
  // Reject before slicing: a count larger than the blob is nonsense.
  if (count > cursor.buf.byteLength) return null;
  let start: number;
  if (count <= 4) {
    start = entry + 8; // small values live inline in the value field
  } else {
    const offset = readU32(cursor, entry + 8);
    if (offset === null) return null;
    start = cursor.base + offset;
  }
  const end = start + count;
  if (start < 0 || end > cursor.buf.byteLength) return null;
  return sanitise(cursor.buf.toString('latin1', start, end));
}

/**
 * Strip the trailing NUL and every control character, collapse runs of
 * whitespace, and drop the value outright when it is implausibly long.
 */
function sanitise(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || cleaned.length > MAX_VALUE_CHARS) return null;
  return cleaned;
}

/**
 * EXIF spells timestamps `YYYY:MM:DD HH:MM:SS` with no zone. Normalise to
 * `YYYY-MM-DDTHH:MM:SS` — still zone-less (inventing UTC would be a lie),
 * but sortable and recognisable. Anything else is dropped.
 */
function normaliseExifDate(raw: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  return `${m[1]!}-${m[2]!}-${m[3]!}T${m[4]!}:${m[5]!}:${m[6]!}`;
}

/** Copy defined fields only (exactOptionalPropertyTypes-safe). */
function assign(target: ExifFacts, source: ExifFacts): void {
  for (const key of EXIF_FACT_ORDER) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

function readU16(cursor: Cursor, at: number): number | null {
  if (at < 0 || at + 2 > cursor.buf.byteLength) return null;
  return cursor.littleEndian ? cursor.buf.readUInt16LE(at) : cursor.buf.readUInt16BE(at);
}

function readU32(cursor: Cursor, at: number): number | null {
  if (at < 0 || at + 4 > cursor.buf.byteLength) return null;
  return cursor.littleEndian ? cursor.buf.readUInt32LE(at) : cursor.buf.readUInt32BE(at);
}
