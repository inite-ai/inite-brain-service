import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
  Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { evidenceBlobUploadEnabled, evidenceMaxBytes } from '../common/evidence-flags';

/** The multipart part name carrying the bytes. */
export const EVIDENCE_BLOB_FIELD = 'file';

/**
 * Memory-storage ceiling, 64 MiB. Multer's default storage is in-memory,
 * so an accepted part is a resident Buffer for the life of the request —
 * EVIDENCE_MAX_BYTES defaults to 1 GiB, which is a fine bound on what a
 * caller may CLAIM an observation weighs and a terrible bound on what one
 * request may pin in the heap. The effective transfer cap is therefore
 * `min(EVIDENCE_MAX_BYTES, this)`: raising the env knob past the ceiling
 * raises nothing (deny-overrides), lowering it below takes effect at
 * once. A streaming/disk-backed adapter is the follow-up that lifts this.
 */
const TRANSFER_CEILING_BYTES = 67_108_864;

/**
 * The multipart part as multer's memory storage hands it over. Declared
 * locally rather than imported from `@types/multer`: the type is four
 * fields we actually read, and the alternative is a new devDependency on
 * a supply-chain-gated tree for an interface we can spell ourselves.
 * (`@nestjs/platform-express` already depends on multer at runtime — no
 * new runtime dependency is introduced by this surface.)
 */
export interface UploadedEvidenceBlob {
  /** Original client-side filename — never used as a path. */
  originalname: string;
  /** The part's declared Content-Type; checked against the allowlist. */
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Blob-upload multipart gate (Brain v2.1 MM-7).
 *
 * Two jobs the stock `FileInterceptor(...)` decorator cannot do, both
 * because a decorator argument is evaluated ONCE at module load:
 *
 *  1. Flag gate BEFORE parsing. `EVIDENCE_BLOB_UPLOAD_ENABLED` off must
 *     answer a bare 404 without buffering the caller's bytes — and it
 *     must be thrown HERE, not in the handler: parameter pipes run after
 *     interceptors, so an unparsed multipart body would fail DTO
 *     validation with a 400 and thereby advertise that the dark route
 *     exists. Throwing from the interceptor keeps the off-state answer
 *     byte-identical to every other gated route.
 *  2. Runtime-mutable size cap. `limits.fileSize` is fixed at decorator
 *     evaluation; resolving it per call keeps EVIDENCE_MAX_BYTES the
 *     live knob the catalogue promises. Delegates are memoised per cap,
 *     so a stable configuration builds exactly one multer instance.
 *
 * An over-cap part fails inside multer, which Nest maps to 413 — the
 * connection is aborted mid-upload rather than after a full buffer.
 */
@Injectable()
export class EvidenceBlobUploadInterceptor implements NestInterceptor {
  private readonly delegates = new Map<number, NestInterceptor>();

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (!evidenceBlobUploadEnabled()) throw new NotFoundException();
    return this.delegateFor(Math.min(evidenceMaxBytes(), TRANSFER_CEILING_BYTES)).intercept(
      context,
      next,
    );
  }

  /** One memoised multer-backed interceptor per effective byte cap. */
  private delegateFor(cap: number): NestInterceptor {
    const cached = this.delegates.get(cap);
    if (cached) return cached;
    const Mixin: Type<NestInterceptor> = FileInterceptor(EVIDENCE_BLOB_FIELD, {
      // files: 1 — a registration is one observation, not a batch.
      // fields/parts bound the metadata side so a multipart body cannot
      // become an unbounded field storm.
      limits: { fileSize: cap, files: 1, fields: 32, parts: 40 },
    });
    const made = new Mixin();
    this.delegates.set(cap, made);
    return made;
  }
}
