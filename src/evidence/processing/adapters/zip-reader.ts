import { inflateRawSync } from 'node:zlib';

/**
 * A bounded ZIP reader for the OOXML containers (docx / xlsx / pptx are
 * ZIP archives of XML parts). No dependency: the archive format needed
 * here is the central-directory walk plus STORE / DEFLATE entries, ~80
 * lines that we can bound ourselves — and bounding is the whole point.
 * A container is a delivery vehicle (upload-media-types.ts), so every
 * read is fenced:
 *
 *   - only the parts the caller NAMES are inflated (never "everything");
 *   - each part inflates under `maxPartBytes` (zlib's maxOutputLength —
 *     a zip bomb fails as a run error, never an OOM);
 *   - the central directory is capped at `maxEntries`, so a crafted
 *     directory cannot spin a worker;
 *   - encryption, multi-disk archives and unsupported methods are
 *     refused by name.
 *
 * ZIP64 is not supported: an office document over 4 GiB is far outside
 * the evidence size cap anyway.
 */

export interface ZipReadOptions {
  /** Parts to inflate — a predicate over the entry name. */
  select: (name: string) => boolean;
  /** Inflated size cap per selected part. */
  maxPartBytes: number;
  /** Central-directory entries walked at most. */
  maxEntries?: number | undefined;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const DEFAULT_MAX_ENTRIES = 4096;
/** EOCD is 22 bytes + a comment of at most 65535. */
const EOCD_SEARCH_WINDOW = 22 + 0xffff;

/** Inflate the selected parts of a ZIP buffer: name → bytes. */
export function readZipParts(zip: Buffer, opts: ZipReadOptions): Map<string, Buffer> {
  const eocd = findEocd(zip);
  const diskNumber = zip.readUInt16LE(eocd + 4);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const cenOffset = zip.readUInt32LE(eocd + 16);
  if (diskNumber !== 0) throw new Error('multi-disk ZIP archives are not supported');
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (entryCount > maxEntries) {
    throw new Error(`ZIP central directory has ${String(entryCount)} entries (cap ${String(maxEntries)})`);
  }
  const out = new Map<string, Buffer>();
  let p = cenOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('ZIP central directory is corrupt');
    }
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!opts.select(name)) continue;
    if (flags & FLAG_ENCRYPTED) throw new Error(`ZIP part "${name}" is encrypted`);
    if (uncompressedSize > opts.maxPartBytes) {
      throw new Error(
        `ZIP part "${name}" declares ${String(uncompressedSize)} bytes (cap ${String(opts.maxPartBytes)})`,
      );
    }
    out.set(name, readLocalEntry(zip, { name, localOffset, method, compressedSize, maxOut: opts.maxPartBytes }));
  }
  return out;
}

function readLocalEntry(
  zip: Buffer,
  e: { name: string; localOffset: number; method: number; compressedSize: number; maxOut: number },
): Buffer {
  const h = e.localOffset;
  if (h + 30 > zip.length || zip.readUInt32LE(h) !== LOC_SIG) {
    throw new Error(`ZIP local header of "${e.name}" is corrupt`);
  }
  const nameLen = zip.readUInt16LE(h + 26);
  const extraLen = zip.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > zip.length) throw new Error(`ZIP part "${e.name}" runs past the end of the archive`);
  const data = zip.subarray(start, end);
  if (e.method === METHOD_STORE) return Buffer.from(data);
  if (e.method === METHOD_DEFLATE) {
    // maxOutputLength turns a bomb into a thrown RangeError — the run
    // fails with the part named instead of the worker running out.
    try {
      return inflateRawSync(data, { maxOutputLength: e.maxOut });
    } catch (err) {
      throw new Error(`ZIP part "${e.name}" failed to inflate: ${(err as Error).message}`);
    }
  }
  throw new Error(`ZIP part "${e.name}" uses unsupported compression method ${String(e.method)}`);
}

function findEocd(zip: Buffer): number {
  const floor = Math.max(0, zip.length - EOCD_SEARCH_WINDOW);
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a ZIP archive (no end-of-central-directory record)');
}
