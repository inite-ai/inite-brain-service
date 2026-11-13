import { spawn } from 'node:child_process';

/**
 * Any accepted audio or video container → 16 kHz mono float PCM, the input
 * Whisper reads, through the ffmpeg binary that ships as the ffmpeg-static
 * dependency (no system package, no network: the binary is fetched when
 * the image is built, pinned by the lockfile).
 *
 * The bytes go in on stdin and the samples come out on stdout, so nothing
 * touches the filesystem. `-vn` drops any video stream, so a video's sound
 * is decoded the same way as a recording. Bounded by a sample cap (a
 * recording longer than the cap is refused, never truncated, so a partial
 * transcript never reads as a whole one) and a wall-clock deadline that
 * kills the process.
 */
export const ASR_SAMPLE_RATE = 16_000;

export interface DecodeLimits {
  /** Longest recording accepted, in seconds. */
  maxSeconds: number;
  /** Wall-clock bound on the decode. */
  deadlineMs: number;
}

/** The path of the shipped ffmpeg binary, or null when this build has none. */
export function ffmpegPath(): string | null {
  try {
    // A CommonJS module whose export is the binary path (null on an
    // unsupported platform).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('ffmpeg-static') as unknown;
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
}

export async function decodeToPcm(bytes: Buffer, limits: DecodeLimits): Promise<Float32Array> {
  const pcm = await runFfmpeg(
    ['-vn', '-ac', '1', '-ar', String(ASR_SAMPLE_RATE), '-f', 'f32le'],
    bytes,
    {
      maxOutBytes: limits.maxSeconds * ASR_SAMPLE_RATE * 4,
      deadlineMs: limits.deadlineMs,
      overflow: `recording is longer than ${String(limits.maxSeconds)} s — refusing a partial transcript`,
    },
  );
  // Copy into an aligned buffer: Float32Array needs a 4-byte offset.
  const out = new Float32Array(Math.floor(pcm.byteLength / 4));
  Buffer.from(out.buffer).set(pcm.subarray(0, out.length * 4));
  return out;
}

export interface FfmpegRun {
  /** Output larger than this kills the process: refused, never truncated. */
  maxOutBytes: number;
  deadlineMs: number;
  /** The refusal message when the output overflows. */
  overflow: string;
}

/**
 * One ffmpeg pass, stdin → stdout: `-i pipe:0`, then `outputArgs`, then
 * `pipe:1`. Bounded by an output cap and a wall-clock deadline that kills
 * the process; nothing touches the filesystem.
 */
export async function runFfmpeg(
  outputArgs: readonly string[],
  bytes: Buffer,
  run: FfmpegRun,
): Promise<Buffer> {
  const bin = ffmpegPath();
  if (!bin) throw new Error('no ffmpeg binary ships with this build');
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...outputArgs, 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failed: Error | null = null;
    const fail = (err: Error) => {
      if (failed) return;
      failed = err;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => fail(new Error(`ffmpeg exceeded ${String(run.deadlineMs)} ms`)),
      run.deadlineMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > run.maxOutBytes) {
        fail(new Error(run.overflow));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => fail(err));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code !== 0)
        return reject(
          new Error(
            `ffmpeg decode failed: ${stderr.trim().slice(0, 300) || `exit ${String(code)}`}`,
          ),
        );
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(bytes);
  });
}
