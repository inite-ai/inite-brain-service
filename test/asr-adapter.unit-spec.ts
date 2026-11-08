/**
 * AsrAdapter (#900 step 4): speech to text, locally. The shipped ffmpeg
 * decodes a real mp3 to 16 kHz mono; the transcriber is a test double (a
 * unit test never loads a model). Pinned: the gate, the language the run
 * reads in (the tenant's, in the fingerprint), the per-minute windows with
 * their timeRange locators, and that silence fails the run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AsrAdapter,
  setTranscriberForTesting,
  windows,
  type Transcriber,
} from '../src/evidence/processing/adapters/asr.adapter';
import {
  ASR_SAMPLE_RATE,
  decodeToPcm,
  ffmpegPath,
} from '../src/evidence/processing/adapters/audio-decode';
import { processorConfigFingerprint } from '../src/evidence/processing/processor-fingerprint';
import type { ProcessorInput } from '../src/evidence/processing/processor-adapter';

const MP3 = readFileSync(join(__dirname, 'eval/media/audio/ru-note.mp3'));

function input(bytes: Buffer, tenantLang?: string): ProcessorInput {
  return {
    asset: {
      id: 'evidence_asset:a',
      modality: 'audio',
      mediaType: 'audio/mpeg',
      availability: 'hot',
      byteLength: bytes.byteLength,
    },
    openStream: () => Promise.resolve(Readable.from([bytes])),
    tenantLang,
  };
}

const saved = process.env.EVIDENCE_ASR_ENABLED;
afterEach(() => {
  setTranscriberForTesting(undefined);
  if (saved === undefined) delete process.env.EVIDENCE_ASR_ENABLED;
  else process.env.EVIDENCE_ASR_ENABLED = saved;
});

describe('AsrAdapter', () => {
  const adapter = new AsrAdapter();

  it('accepts audio and video it can decode, only when switched on', () => {
    delete process.env.EVIDENCE_ASR_ENABLED;
    expect(adapter.accepts('audio', 'audio/mpeg')).toBe(false);
    process.env.EVIDENCE_ASR_ENABLED = '1';
    expect(ffmpegPath()).not.toBeNull();
    expect(adapter.accepts('audio', 'audio/mpeg')).toBe(true);
    expect(adapter.accepts('video', 'video/mp4')).toBe(true);
    expect(adapter.accepts('image', 'image/png')).toBe(false);
    expect(adapter.accepts('audio', 'audio/x-unknown')).toBe(false);
  });

  it('the shipped ffmpeg decodes an mp3 to 16 kHz mono samples', async () => {
    const pcm = await decodeToPcm(MP3, { maxSeconds: 60, deadlineMs: 30_000 });
    const seconds = pcm.length / ASR_SAMPLE_RATE;
    expect(seconds).toBeGreaterThan(3);
    expect(seconds).toBeLessThan(15);
    expect(Math.max(...pcm.subarray(0, 64_000).map(Math.abs))).toBeGreaterThan(0.01);
  });

  it('refuses a recording longer than the cap rather than truncating it', async () => {
    await expect(decodeToPcm(MP3, { maxSeconds: 1, deadlineMs: 30_000 })).rejects.toThrow(
      /partial transcript/,
    );
    await expect(
      decodeToPcm(Buffer.from('not audio'), { maxSeconds: 60, deadlineMs: 30_000 }),
    ).rejects.toThrow(/decode failed/);
  });

  it("transcribes in the tenant's language, which rides the fingerprint", async () => {
    process.env.EVIDENCE_ASR_ENABLED = '1';
    const calls: Array<string | undefined> = [];
    const fake: Transcriber = async (samples, opts) => {
      calls.push(opts.language);
      expect(samples.length).toBeGreaterThan(ASR_SAMPLE_RATE);
      return [{ timestamp: [0, 3.2], text: ' Пароль сменили.' }];
    };
    setTranscriberForTesting(fake);
    const out = await adapter.process(input(MP3, 'ru'));
    expect(calls).toEqual(['ru']);
    expect(out).toEqual([
      {
        kind: 'asr',
        content: 'Пароль сменили.',
        lang: 'ru',
        locator: { kind: 'timeRange', startMs: 0, endMs: 3200 },
        label: '0:00–0:03',
      },
    ]);
    expect(processorConfigFingerprint(adapter, input(MP3, 'ru'))).not.toBe(
      processorConfigFingerprint(adapter, input(MP3, 'pt')),
    );
  });

  it('silence fails the run', async () => {
    process.env.EVIDENCE_ASR_ENABLED = '1';
    setTranscriberForTesting(async () => [{ timestamp: [0, 1], text: '   ' }]);
    await expect(adapter.process(input(MP3))).rejects.toThrow(/no speech/);
  });
});

describe('transcript windows', () => {
  it('folds chunks into minute windows by their start; the tail ends at the duration', () => {
    expect(
      windows(
        [
          { timestamp: [0, 20], text: 'a' },
          { timestamp: [20, 59], text: 'b' },
          { timestamp: [61, 75], text: 'c' },
          { timestamp: [118, null], text: 'd' },
        ],
        130_000,
      ),
    ).toEqual([
      { startMs: 0, endMs: 59_000, text: 'a b' },
      { startMs: 61_000, endMs: 130_000, text: 'c d' },
    ]);
  });
});
