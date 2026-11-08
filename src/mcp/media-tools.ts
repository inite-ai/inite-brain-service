import { BadRequestException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sharp from 'sharp';
import { z } from 'zod';
import { pinUserScope } from '../auth/user-scope';
import {
  evidenceBlobUploadEnabled,
  evidenceMaxBytes,
  evidenceRawReadEnabled,
} from '../common/evidence-flags';
import { EVIDENCE_MODALITIES, type EvidenceModality } from '../common/evidence-taxonomy';
import type { EvidenceReadService } from '../evidence/evidence-read.service';
import type { EvidenceUploadService } from '../evidence/evidence-upload.service';
import { readBoundedStream } from '../evidence/processing/adapters/adapter-io';
import {
  type EvidenceStorageRegistry,
  storageRefScheme,
} from '../evidence/storage/storage-adapter';
import {
  EVIDENCE_UPLOAD_MEDIA_TYPES,
  normalizeUploadMediaType,
} from '../evidence/upload-media-types';
import { isoDateTime } from './iso-datetime';
import { asStructuredContent } from './structured';

/** Resolved per call: the evidence services live in EvidenceModule. */
export interface MediaToolDeps {
  uploads?: (() => EvidenceUploadService | undefined) | undefined;
  reads?: (() => EvidenceReadService | undefined) | undefined;
  storage?: (() => EvidenceStorageRegistry | undefined) | undefined;
}

/**
 * The longest edge an image is returned at. A vision model reads an image
 * at about this size and gains nothing above it; the reply stays a few
 * hundred kilobytes (media-reading-work.service.ts uses the same bound).
 */
const MAX_EDGE_PX = 1568;

/** Audio is returned as stored, up to this size; longer recordings go over REST. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Base64 an upload may carry. The JSON body cap (MAX_BODY_SIZE, 1 MB by
 * default) binds first; this only stops a call that could never fit.
 */
const MAX_UPLOAD_BASE64 = 16 * 1024 * 1024;

/** The modality a media type is accepted under (upload-media-types.ts), first match. */
export function modalityOf(mediaType: string): EvidenceModality | undefined {
  const type = normalizeUploadMediaType(mediaType);
  return EVIDENCE_MODALITIES.find((m) => EVIDENCE_UPLOAD_MEDIA_TYPES[m].includes(type));
}

/**
 * read_media (#900 step 3): the bytes of a stored image or recording, as an
 * MCP image or audio block, so an agent can look at what a memory cites.
 * Every read runs the raw-evidence ladder of the REST raw route
 * (EvidenceReadService.runLadder): tenant, availability, grants, a pack's
 * raw-evidence consent, the media PII gate (brain:read_media for a
 * PII-classed asset) and blob presence, with an access-audit row written
 * before a byte leaves. Registered while EVIDENCE_RAW_READ_ENABLED is on (the default, as for the REST route)
 * and only for a key holding brain:read_media: a tool costs every session's
 * tools/list, and most keys never read media.
 */
export function registerMediaReadTools(p: {
  server: McpServer;
  companyId: string;
  scopes: readonly string[];
  actorKeyHash: string;
  deps: MediaToolDeps;
}): void {
  // Listed only to a key that may read media: the raw-evidence route is
  // free to leave on, a tool in every tools/list is not.
  if (!evidenceRawReadEnabled() || !p.scopes.includes('brain:read_media')) return;
  const { server, companyId, scopes, actorKeyHash, deps } = p;
  server.registerTool(
    'read_media',
    {
      title: 'Read media',
      description:
        'A stored image (image block, ≤1568 px) or recording (audio block), by the evidence asset or fragment id a fact cites. Needs raw-evidence consent and the brain:read_media scope.',
      inputSchema: {
        assetId: z.string().max(200).optional(),
        fragmentId: z.string().max(200).optional(),
      },
    },
    async (args) => {
      if (!args.assetId === !args.fragmentId) {
        throw new BadRequestException('name exactly one of assetId or fragmentId');
      }
      const reads = deps.reads?.();
      const storage = deps.storage?.();
      if (!reads || !storage) throw new BadRequestException('media reads are not available here');
      const blob = await reads.runLadder({
        companyId,
        scopes,
        keyHash: actorKeyHash,
        // The key's own user, as on the REST raw route; no caller-named scope.
        userId: pinUserScope(undefined),
        assetId: args.assetId,
        fragmentId: args.fragmentId,
        verb: 'stream',
      });
      const type = normalizeUploadMediaType(blob.mediaType);
      const kind = modalityOf(type);
      if (kind !== 'image' && kind !== 'audio') {
        throw new BadRequestException(
          `read_media returns images and audio; this asset is ${type}. Its text is in memory`,
        );
      }
      if (kind === 'audio' && blob.byteLength > MAX_AUDIO_BYTES) {
        throw new BadRequestException(
          'this recording is larger than read_media returns (10 MB); fetch it over REST',
        );
      }
      const adapter = storage.get(storageRefScheme(blob.storageRef) ?? '');
      if (!adapter) throw new BadRequestException('media reads are not available here');
      const bytes = await readBoundedStream(
        await adapter.get(blob.storageRef),
        kind === 'audio' ? MAX_AUDIO_BYTES : evidenceMaxBytes(),
      );
      const meta = { assetId: blob.assetIdStr, mediaType: type, byteLength: blob.byteLength };
      const block =
        kind === 'image'
          ? {
              type: 'image' as const,
              mimeType: 'image/jpeg',
              data: (
                await sharp(bytes, { failOn: 'error' })
                  .rotate()
                  .resize({
                    width: MAX_EDGE_PX,
                    height: MAX_EDGE_PX,
                    fit: 'inside',
                    withoutEnlargement: true,
                  })
                  .jpeg({ quality: 85 })
                  .toBuffer()
              ).toString('base64'),
            }
          : { type: 'audio' as const, mimeType: type, data: bytes.toString('base64') };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(meta) }, block],
        structuredContent: asStructuredContent(meta),
      };
    },
  );
}

/**
 * upload_media (#900 step 3): an image, recording or document handed to
 * memory over MCP, the byte door of POST /v1/ingest/evidence-blob
 * (EvidenceUploadService.upload): the same media-type allowlist, custody,
 * quarantine scan and processor dispatch. The modality is the one the
 * media type is accepted under. A file larger than the JSON body cap goes
 * over the REST multipart route. Registered only when
 * EVIDENCE_BLOB_UPLOAD_ENABLED is on; brain:write.
 */
export function registerMediaWriteTools(p: {
  server: McpServer;
  companyId: string;
  deps: MediaToolDeps;
}): void {
  if (!evidenceBlobUploadEnabled()) return;
  const { server, companyId, deps } = p;
  server.registerTool(
    'upload_media',
    {
      title: 'Upload media',
      description:
        'Stores an image, audio recording or document (base64) as evidence in memory. The bytes are kept, scanned and read by the processors the workspace has consented to (text of a PDF, OCR of an image), and what they yield becomes memory that cites the file. Accepted types: images (jpeg, png, gif, webp, avif), audio (mpeg, mp4, aac, ogg, wav, flac), video (mp4, webm, quicktime), PDF, plain text, markdown, csv, docx, xlsx, pptx and email (rfc822). The request body is capped (1 MB by default), so a larger file goes over the REST upload. Returns the asset id.',
      inputSchema: {
        data: z.string().min(1).max(MAX_UPLOAD_BASE64).describe('The file, base64'),
        mediaType: z.string().min(3).max(120).describe('e.g. image/png'),
        occurredAt: isoDateTime()
          .optional()
          .describe('When the file was made or the event it records happened; now by default'),
        vertical: z.string().min(1).max(64).optional().describe('Source label; "media" by default'),
        userId: z
          .string()
          .max(200)
          .optional()
          .describe("Per-user memory scope: only this user's memory. Omit for tenant-global"),
        packId: z.string().max(64).optional().describe('Pack whose processors read it first'),
      },
    },
    async (args) => {
      const uploads = deps.uploads?.();
      if (!uploads) throw new BadRequestException('media uploads are not available here');
      const modality = modalityOf(args.mediaType);
      if (!modality) {
        throw new BadRequestException(`mediaType '${args.mediaType}' is not accepted`);
      }
      const buffer = Buffer.from(args.data, 'base64');
      if (buffer.byteLength === 0) throw new BadRequestException('data is not base64');
      const out = await uploads.upload(
        companyId,
        { originalname: 'upload', mimetype: args.mediaType, size: buffer.byteLength, buffer },
        {
          modality,
          mediaType: args.mediaType,
          occurredAt: args.occurredAt ? new Date(args.occurredAt) : new Date(),
          vertical: args.vertical ?? 'media',
          userId: pinUserScope(args.userId),
          packId: args.packId,
        },
      );
      const result = {
        assetId: out.assetId,
        deduped: out.deduped,
        mediaType: out.mediaType,
        byteLength: out.byteLength,
        quarantineStatus: out.quarantineStatus,
        dispatched: out.dispatched,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: asStructuredContent(result),
      };
    },
  );
}
