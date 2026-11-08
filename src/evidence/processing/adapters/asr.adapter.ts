import { Injectable } from '@nestjs/common';
import { applyTransformersCacheDir } from '../../../ai/transformers-cache';
import {
  evidenceAsrEnabled,
  evidenceAsrModel,
  evidenceMaxBytes,
} from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import { EVIDENCE_UPLOAD_MEDIA_TYPES, normalizeUploadMediaType } from '../../upload-media-types';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes, withDeadline } from './adapter-io';
import { ASR_SAMPLE_RATE, decodeToPcm, ffmpegPath } from './audio-decode';

/** One timed piece of transcript, as Whisper returns it (seconds; end null at the tail). */
export interface AsrChunk {
  timestamp: [number, number | null];
  text: string;
}

/** Whisper over 16 kHz mono samples. */
export type Transcriber = (
  samples: Float32Array,
  opts: { language?: string | undefined },
) => Promise<AsrChunk[]>;

/** Longest recording transcribed: two hours. */
const MAX_SECONDS = 2 * 60 * 60;
/** Wall-clock bound on decoding a recording. */
const DECODE_DEADLINE_MS = 10 * 60_000;
/** Transcript windows: one cited fragment per minute of audio. */
const WINDOW_MS = 60_000;
/** Whisper's own chunking: 30 s windows with 5 s of overlap, the model's design. */
const CHUNK_S = 30;
const STRIDE_S = 5;

let transcriber: Promise<Transcriber> | undefined;

/** The Whisper pipeline, loaded once per process on first use. */
function loadTranscriber(model: string): Promise<Transcriber> {
  transcriber ??= (async () => {
    const transformers = await import('@xenova/transformers');
    applyTransformersCacheDir(transformers);
    const asr = (await transformers.pipeline('automatic-speech-recognition', model)) as unknown as (
      a: Float32Array,
      o: Record<string, unknown>,
    ) => Promise<{ chunks?: AsrChunk[]; text?: string }>;
    return async (samples, opts) => {
      const out = await asr(samples, {
        chunk_length_s: CHUNK_S,
        stride_length_s: STRIDE_S,
        return_timestamps: true,
        task: 'transcribe',
        ...(opts.language ? { language: opts.language } : {}),
      });
      return out.chunks ?? (out.text ? [{ timestamp: [0, null], text: out.text }] : []);
    };
  })();
  return transcriber;
}

/** Test seam: the transcriber the adapter uses (a real model is never loaded in unit tests). */
export function setTranscriberForTesting(t: Transcriber | undefined): void {
  transcriber = t ? Promise.resolve(t) : undefined;
}

/**
 * AsrAdapter — speech to text, locally (#900 step 4). Audio was accepted,
 * stored and never read; a meeting recording or a voice note was mute to
 * memory. ffmpeg decodes any accepted container (and the sound of a video)
 * to 16 kHz mono; Whisper (transformers.js, EVIDENCE_ASR_MODEL) transcribes
 * it. No key and no network once the model is in the transformers cache.
 *
 * LANGUAGE. Whisper in transformers.js v2 does not detect the language: it
 * transcribes as English, and a Russian recording came back translated
 * ("The bill is number 2026118…"). The run reads in the tenant's own
 * language (ProcessorInput.tenantLang, the broker's most common turn
 * language), the same rule OCR follows; it rides the fingerprint.
 *
 * OUTPUT. One output per minute of audio with a `timeRange` locator, so a
 * fact can cite "this minute of this recording"; the words carry into
 * memory through the evidence → document bridge (asr carries words).
 * Empty speech fails the run rather than storing nothing as a reading.
 */
@Injectable()
export class AsrAdapter implements ProcessorAdapter {
  readonly capability = 'asr' as const;
  readonly version = 'audio-asr-whisper-v1';

  configParts(input?: ProcessorInput): string[] {
    return [
      `model=${evidenceAsrModel()}`,
      `lang=${input?.tenantLang ?? 'none'}`,
      `chunk=${String(CHUNK_S)}/${String(STRIDE_S)}`,
      `window=${String(WINDOW_MS)}`,
    ];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (!evidenceAsrEnabled() || ffmpegPath() === null) return false;
    if (modality !== 'audio' && modality !== 'video') return false;
    return EVIDENCE_UPLOAD_MEDIA_TYPES[modality].includes(normalizeUploadMediaType(mediaType));
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const samples = await decodeToPcm(bytes, {
      maxSeconds: MAX_SECONDS,
      deadlineMs: DECODE_DEADLINE_MS,
    });
    const seconds = samples.length / ASR_SAMPLE_RATE;
    const transcribe = await loadTranscriber(evidenceAsrModel());
    const chunks = await withDeadline(transcribe(samples, { language: input.tenantLang }), {
      // CPU Whisper small runs at about half real time; four times the
      // duration plus model warm-up is a generous bound.
      ms: 120_000 + seconds * 4_000,
      label: 'speech recognition',
    });
    const outputs = windows(chunks, seconds * 1000).map((w) => ({
      kind: 'asr' as const,
      content: w.text,
      lang: input.tenantLang,
      locator: { kind: 'timeRange' as const, startMs: w.startMs, endMs: w.endMs },
      label: `${clock(w.startMs)}–${clock(w.endMs)}`,
    }));
    if (outputs.length === 0) throw new Error('no speech recognised in the recording');
    return outputs;
  }
}

/**
 * Whisper's chunks folded into fixed windows of WINDOW_MS: each chunk goes
 * to the window its start falls in; a window's span is its chunks' span.
 */
export function windows(
  chunks: readonly AsrChunk[],
  durationMs: number,
): Array<{ startMs: number; endMs: number; text: string }> {
  const byWindow = new Map<number, { startMs: number; endMs: number; texts: string[] }>();
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(c.timestamp[0] * 1000));
    const endMs = Math.round((c.timestamp[1] ?? durationMs / 1000) * 1000);
    const key = Math.floor(startMs / WINDOW_MS);
    const w = byWindow.get(key) ?? { startMs, endMs, texts: [] };
    w.startMs = Math.min(w.startMs, startMs);
    w.endMs = Math.max(w.endMs, endMs, w.startMs + 1);
    w.texts.push(text);
    byWindow.set(key, w);
  }
  return [...byWindow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, w]) => ({ startMs: w.startMs, endMs: w.endMs, text: w.texts.join(' ') }));
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}
