import type { Readable } from 'node:stream';
import type { ProcessorInput } from '../processor-adapter';

/**
 * Shared byte-side plumbing for the REAL (byte-reading) processor
 * adapters. Two rules live here so every adapter obeys them identically:
 *
 *   * a read is BOUNDED — the stream is destroyed the moment it crosses
 *     the cap, so an oversized (or endless) blob costs a bounded amount
 *     of memory and ends as an honest failed run, never an OOM;
 *   * work is DEADLINED — a decoder handed a crafted file must not be
 *     able to hang a worker. The deadline is a failure bound, not an
 *     output knob, so it deliberately does NOT ride configParts()
 *     (the text-passthrough precedent: a cap failure is a run error, not
 *     a silent output change, and must not fork the idempotency key).
 */

/** Read a whole stream into memory, aborting as soon as it passes `cap`. */
export async function readBoundedStream(stream: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.byteLength;
      if (total > cap) {
        throw new Error(`asset bytes exceed the evidence size cap (${String(cap)} bytes)`);
      }
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * Open the asset's bytes, or fail with a message that names the reason a
 * byte-reading adapter cannot run (availability / storage-scheme), rather
 * than a bare null dereference.
 */
export async function openAssetBytes(input: ProcessorInput, cap: number): Promise<Buffer> {
  if (input.openStream === null) {
    throw new Error(
      'asset bytes are not readable — a byte-reading processor needs an ' +
        "adapter-stored blob (availability 'hot' with a registered storageRef scheme)",
    );
  }
  return readBoundedStream(await input.openStream(), cap);
}

export interface Deadline {
  ms: number;
  /** Named in the failure message the run row records. */
  label: string;
  /**
   * Escape hatch a decoder needs (destroy the parser, release its
   * buffers) — losing the race does NOT by itself stop the underlying
   * work, so a hung decoder keeps its memory until this runs.
   */
  onTimeout?: () => void;
}

/** Race `work` against a wall-clock deadline. */
export async function withDeadline<T>(work: Promise<T>, deadlineOpts: Deadline): Promise<T> {
  const { ms, label, onTimeout } = deadlineOpts;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} exceeded its ${String(ms)}ms deadline`));
    }, ms);
    // A pending deadline must never hold the process open on shutdown.
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
