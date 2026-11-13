import sharp from 'sharp';
import { canCrop, cropFragment, regionBox } from '../src/evidence/fragment-crop';
import { ffmpegPath } from '../src/evidence/processing/adapters/audio-decode';

const LIMITS = { maxBytes: 10 * 1024 * 1024, deadlineMs: 30_000 };

/** A 200×100 image: left half red, right half blue. */
async function halves(): Promise<Buffer> {
  const left = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .composite([{ input: left, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

describe('fragment crop — which pairs are cut', () => {
  it('an image region and a recording span are cut; the rest is served whole', () => {
    const region = { kind: 'pageRegion', page: 0, x: 0, y: 0, w: 0.5, h: 1 } as const;
    const span = { kind: 'timeRange', startMs: 0, endMs: 500 } as const;
    expect(canCrop('image/png', region)).toBe(true);
    expect(canCrop('audio/mpeg', span)).toBe(true);
    // A PDF page region, a later image page, a video span: no cutter yet.
    expect(canCrop('application/pdf', region)).toBe(false);
    expect(canCrop('image/png', { ...region, page: 1 })).toBe(false);
    expect(canCrop('video/mp4', span)).toBe(false);
    expect(canCrop('text/plain', { kind: 'charRange', start: 0, end: 3 })).toBe(false);
    expect(canCrop('image/png', undefined)).toBe(false);
  });

  it('a normalised region maps to an in-bounds pixel box of at least one pixel', () => {
    expect(regionBox({ x: 0.5, y: 0, w: 0.5, h: 1 }, { width: 200, height: 100 })).toEqual({
      left: 100,
      top: 0,
      width: 100,
      height: 100,
    });
    // A sliver narrower than a pixel still yields one pixel, inside the raster.
    expect(
      regionBox({ x: 0.999, y: 0.999, w: 0.0001, h: 0.0001 }, { width: 10, height: 10 }),
    ).toEqual({ left: 9, top: 9, width: 1, height: 1 });
  });
});

describe('fragment crop — images', () => {
  it('serves only the region: the right half of a red|blue image is blue', async () => {
    const part = await cropFragment(
      await halves(),
      {
        mediaType: 'image/png',
        locator: { kind: 'pageRegion', page: 0, x: 0.5, y: 0, w: 0.5, h: 1 },
      },
      LIMITS,
    );
    expect(part?.mediaType).toBe('image/png');
    expect(part?.cut).toBe('pageRegion');
    const { data, info } = await sharp(part!.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([100, 100]);
    expect([data[0], data[1], data[2]]).toEqual([0, 0, 255]);
  });

  it('measures the region on the EXIF-oriented raster, the frame OCR boxes are in', async () => {
    // Stored 200×100 with orientation 6 (rotate 90° CW to view): viewed 100×200.
    const stored = await sharp(await halves())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const part = await cropFragment(
      stored,
      {
        mediaType: 'image/jpeg',
        locator: { kind: 'pageRegion', page: 0, x: 0, y: 0, w: 1, h: 0.5 },
      },
      LIMITS,
    );
    const meta = await sharp(part!.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([100, 100]);
  });

  it('a corrupt image fails the cut rather than falling back to the whole', async () => {
    await expect(
      cropFragment(
        Buffer.from('not an image'),
        {
          mediaType: 'image/png',
          locator: { kind: 'pageRegion', page: 0, x: 0, y: 0, w: 1, h: 1 },
        },
        LIMITS,
      ),
    ).rejects.toThrow();
  });
});

const withFfmpeg = ffmpegPath() ? describe : describe.skip;

withFfmpeg('fragment crop — recordings', () => {
  it('serves only the span, as WAV of that length', async () => {
    const source = generateTone();
    const part = await cropFragment(
      source,
      { mediaType: 'audio/wav', locator: { kind: 'timeRange', startMs: 500, endMs: 1500 } },
      LIMITS,
    );
    expect(part?.mediaType).toBe('audio/wav');
    expect(part?.cut).toBe('timeRange');
    // 1 s of 16 kHz mono 16-bit PCM is 32 000 bytes, plus the header.
    const samples = (part!.bytes.byteLength - 44) / 2;
    expect(samples).toBeGreaterThan(15_000);
    expect(samples).toBeLessThan(17_000);
  });
});

/** A 2 s 16 kHz mono WAV of a 440 Hz tone, built in memory. */
function generateTone(): Buffer {
  const rate = 16_000;
  const n = rate * 2;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), 44 + i * 2);
  }
  return buf;
}
