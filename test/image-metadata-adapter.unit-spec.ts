/**
 * Real image-metadata processor (Brain v2.1 MM) — asserts against REAL
 * decoded bytes, not a mock: every fixture is synthesised in-process by
 * sharp (tiny, generated, nothing binary committed), so the spec proves
 * the adapter reads what libvips actually reports.
 *
 * The privacy contract is a first-class assertion here: an image carrying
 * GPS, an Artist string and a body serial number must yield derived
 * content that contains NONE of them while still carrying the allowlisted
 * make / model / software / capture timestamp.
 */
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { ImageMetadataAdapter } from '../src/evidence/processing/adapters/image-metadata.adapter';
import { readAllowlistedExif } from '../src/evidence/processing/adapters/exif-allowlist';
import type {
  ProcessorAdapter,
  ProcessorInput,
} from '../src/evidence/processing/processor-adapter';
import { processorConfigFingerprint } from '../src/evidence/processing/processor-fingerprint';

/**
 * Jest-worker hygiene, not a behavioural knob: libvips otherwise spins a
 * thread pool and an operation cache inside every worker it is loaded
 * into. This repo has a documented history of native-module worker
 * crashes under the unit suite (the ONNX SIGABRT class), so the fixtures
 * run libvips single-threaded and cacheless. Production is untouched —
 * this is spec-local setup.
 */
sharp.concurrency(1);
sharp.cache(false);

const adapter = new ImageMetadataAdapter();

const PNG_PIXELS = { width: 6, height: 4 };

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: PNG_PIXELS.width,
      height: PNG_PIXELS.height,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A JPEG carrying both allowlisted AND deliberately-excluded EXIF. */
async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 5, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg({ quality: 70 })
    .withExif({
      IFD0: {
        Make: 'ACME Optics',
        Model: 'Model Q',
        Software: 'brain-fixture 1.0',
        DateTime: '2024:05:07 09:00:00',
        Artist: 'Jane Doe',
        Copyright: 'Jane Doe 2024',
        ImageDescription: 'reach jane at jane@example.com',
      },
      IFD2: { DateTimeOriginal: '2024:05:07 12:34:56', BodySerialNumber: 'SN-12345' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .toBuffer();
}

function inputFor(
  bytes: Buffer | null,
  over: Partial<ProcessorInput['asset']> = {},
): ProcessorInput {
  const asset: ProcessorInput['asset'] = {
    id: 'evidence_asset:a1',
    modality: 'image',
    mediaType: 'image/png',
    availability: bytes === null ? 'external' : 'hot',
    byteLength: bytes?.byteLength ?? 123,
    ...over,
  };
  return {
    asset,
    openStream: bytes === null ? null : () => Promise.resolve(Readable.from([bytes])),
  };
}

/** Parse the `key: value` block the adapter renders below the headline. */
function fieldsOf(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n').slice(2)) {
    const at = line.indexOf(': ');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 2);
  }
  return out;
}

describe('ImageMetadataAdapter.accepts', () => {
  it('takes decodable image media types on the image modality', () => {
    expect(adapter.accepts('image', 'image/png')).toBe(true);
    expect(adapter.accepts('image', 'image/jpeg')).toBe(true);
    expect(adapter.accepts('image', 'image/webp')).toBe(true);
    expect(adapter.accepts('image', 'image/tiff')).toBe(true);
  });

  it('is case- and parameter-insensitive on the media type', () => {
    expect(adapter.accepts('image', 'IMAGE/JPEG')).toBe(true);
    expect(adapter.accepts('image', 'image/png; charset=binary')).toBe(true);
    expect(adapter.accepts('image', '  image/webp  ')).toBe(true);
  });

  it('declines other modalities and undecodable image types', () => {
    expect(adapter.accepts('document', 'image/png')).toBe(false);
    expect(adapter.accepts('video', 'image/png')).toBe(false);
    expect(adapter.accepts('image', 'image/x-icon')).toBe(false);
    expect(adapter.accepts('image', 'application/pdf')).toBe(false);
  });
});

describe('ImageMetadataAdapter.process (decoded bytes)', () => {
  it('reports the REAL pixel geometry, not the declared one', async () => {
    const png = await makePng();
    // The caller lies about the size; the decode must win and say so.
    const [output] = await adapter.process(
      inputFor(png, { width: 4000, height: 3000, byteLength: 999999 }),
    );
    const fields = fieldsOf(output!.content!);
    expect(output!.kind).toBe('caption');
    expect(fields['source']).toBe('decoded bytes');
    expect(fields['format']).toBe('png');
    expect(fields['width']).toBe(String(PNG_PIXELS.width));
    expect(fields['height']).toBe(String(PNG_PIXELS.height));
    expect(fields['channels']).toBe('4');
    expect(fields['hasAlpha']).toBe('true');
    expect(fields['byteLength']).toBe(String(png.byteLength));
    expect(fields['declaredMismatch']).toContain('width declared 4000, decoded 6');
    expect(fields['declaredMismatch']).toContain('height declared 3000, decoded 4');
    expect(fields['declaredMismatch']).toContain('byteLength declared 999999');
  });

  it('opens with a human-readable headline the BM25 lane can serve', async () => {
    const png = await makePng();
    const [output] = await adapter.process(inputFor(png));
    const headline = output!.content!.split('\n')[0]!;
    expect(headline).toContain('png image');
    expect(headline).toContain('6x4 px');
    expect(headline).toContain('with alpha');
    expect(headline).toContain(`${String(png.byteLength)} bytes`);
    // Headline, blank line, then the field block.
    expect(output!.content!.split('\n')[1]).toBe('');
  });

  it('says nothing about a mismatch when the declaration is honest', async () => {
    const png = await makePng();
    const [output] = await adapter.process(
      inputFor(png, { width: PNG_PIXELS.width, height: PNG_PIXELS.height }),
    );
    expect(fieldsOf(output!.content!)['declaredMismatch']).toBeUndefined();
  });

  it('is deterministic — identical bytes render byte-identical content', async () => {
    const png = await makePng();
    const first = await adapter.process(inputFor(png));
    const second = await adapter.process(inputFor(png));
    expect(second[0]!.content).toBe(first[0]!.content);
  });
});

describe('ImageMetadataAdapter EXIF privacy contract', () => {
  it('carries the allowlisted provenance fields', async () => {
    const jpeg = await makeJpegWithExif();
    const [output] = await adapter.process(inputFor(jpeg, { mediaType: 'image/jpeg' }));
    const fields = fieldsOf(output!.content!);
    expect(fields['exif.make']).toBe('ACME Optics');
    expect(fields['exif.model']).toBe('Model Q');
    expect(fields['exif.software']).toBe('brain-fixture 1.0');
    // DateTimeOriginal (shutter) beats IFD0 DateTime (last write).
    expect(fields['exif.capturedAt']).toBe('2024-05-07T12:34:56');
  });

  it('never emits GPS, free-text or serial-number EXIF', async () => {
    const jpeg = await makeJpegWithExif();
    const [output] = await adapter.process(inputFor(jpeg, { mediaType: 'image/jpeg' }));
    const content = output!.content!;
    expect(content).not.toContain('Jane Doe');
    expect(content).not.toContain('jane@example.com');
    expect(content).not.toContain('SN-12345');
    expect(content.toLowerCase()).not.toContain('gpslatitude');
    // The exclusion is stated in the stored content, so it is auditable.
    expect(fieldsOf(content)['gps']).toBe('not extracted (policy)');
  });

  it('omits EXIF keys entirely when the image carries none', async () => {
    const png = await makePng();
    const [output] = await adapter.process(inputFor(png));
    expect(output!.content).not.toContain('exif.make');
    expect(output!.content).not.toContain('exif.capturedAt');
  });
});

describe('readAllowlistedExif hostile input', () => {
  it('returns {} rather than throwing on garbage, truncation and bad magic', () => {
    expect(readAllowlistedExif(Buffer.alloc(0))).toEqual({});
    expect(readAllowlistedExif(Buffer.from('not exif at all'))).toEqual({});
    expect(readAllowlistedExif(Buffer.from('II', 'latin1'))).toEqual({});
    // Right byte-order mark, wrong magic number.
    expect(readAllowlistedExif(Buffer.from('4949ff00080000000000', 'hex'))).toEqual({});
    // Valid header, IFD offset far past the end of the buffer.
    expect(readAllowlistedExif(Buffer.from('49492a00ffffff0f', 'hex'))).toEqual({});
  });

  it('survives a truncated copy of a real EXIF blob at every length', async () => {
    const meta = await sharp(await makeJpegWithExif()).metadata();
    const exif = meta.exif!;
    expect(exif.byteLength).toBeGreaterThan(16);
    for (let cut = 0; cut < exif.byteLength; cut += 7) {
      expect(() => readAllowlistedExif(exif.subarray(0, cut))).not.toThrow();
    }
  });
});

describe('ImageMetadataAdapter byte-less assets', () => {
  it('degrades to a row-metadata rendering and labels it as such', async () => {
    const [output] = await adapter.process(
      inputFor(null, { availability: 'external', width: 800, height: 600, byteLength: 4096 }),
    );
    const content = output!.content!;
    expect(content.split('\n')[0]).toContain('not decoded');
    const fields = fieldsOf(content);
    expect(fields['source']).toBe("row metadata (availability 'external')");
    expect(fields['width']).toBe('800');
    expect(fields['byteLength']).toBe('4096');
    expect(fields['gps']).toBe('not extracted (policy)');
    // Nothing is claimed that only a decode could know.
    expect(fields['format']).toBeUndefined();
    expect(fields['colourSpace']).toBeUndefined();
  });
});

describe('ImageMetadataAdapter failure modes', () => {
  const previousCap = process.env.EVIDENCE_MAX_BYTES;
  afterEach(() => {
    if (previousCap === undefined) delete process.env.EVIDENCE_MAX_BYTES;
    else process.env.EVIDENCE_MAX_BYTES = previousCap;
  });

  it('fails honestly on an oversize blob instead of buffering it', async () => {
    const png = await makePng();
    process.env.EVIDENCE_MAX_BYTES = '16';
    await expect(adapter.process(inputFor(png))).rejects.toThrow(/exceed the evidence size cap/);
  });

  it('fails honestly on corrupt bytes instead of crashing', async () => {
    const junk = Buffer.from('this is definitely not an image, not even a little');
    await expect(adapter.process(inputFor(junk))).rejects.toThrow();
  });

  it('fails honestly on a truncated image header', async () => {
    const png = await makePng();
    await expect(adapter.process(inputFor(png.subarray(0, 20)))).rejects.toThrow();
  });
});

describe('ImageMetadataAdapter fingerprint discipline', () => {
  it('is stable across runs', () => {
    const fp = processorConfigFingerprint(adapter);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(processorConfigFingerprint(new ImageMetadataAdapter())).toBe(fp);
  });

  it('pins the EXIF allowlist and the GPS policy in configParts', () => {
    expect(adapter.configParts()).toEqual(['exif=capturedAt,make,model,software', 'gps=excluded']);
  });

  it('forks the key when the allowlist changes without a version bump', () => {
    const widened: ProcessorAdapter = {
      capability: adapter.capability,
      version: adapter.version,
      configParts: () => ['exif=capturedAt,make,model,software,lens', 'gps=excluded'],
      accepts: () => true,
      process: () => Promise.resolve([]),
    };
    expect(processorConfigFingerprint(widened)).not.toBe(processorConfigFingerprint(adapter));
  });

  it('forks the key on a version bump', () => {
    const bumped: ProcessorAdapter = {
      capability: adapter.capability,
      version: 'image-metadata-v2',
      configParts: () => adapter.configParts(),
      accepts: () => true,
      process: () => Promise.resolve([]),
    };
    expect(processorConfigFingerprint(bumped)).not.toBe(processorConfigFingerprint(adapter));
  });
});
