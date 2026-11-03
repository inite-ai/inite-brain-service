import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import sharp from 'sharp';
import { SurrealService } from '../db/surreal.service';
import { evidenceDocumentBridgeEnabled, evidenceMaxBytes } from '../common/evidence-flags';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type MediaTokenPayload } from '../common/harness-work-token';
import { idTailOf } from '../ingest/ingest-utils';
import { JobClaimService } from '../jobs/job-claim.service';
import type { DomainPackManifest } from '../ai/domain-packs';
import type { EvidenceModality } from '../common/evidence-taxonomy';
import { EvidenceStoreService } from './evidence-store.service';
import { gateProcessorDispatch } from './processing/dispatch-gate';
import { readBoundedStream } from './processing/adapters/adapter-io';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  type EvidenceStorageRegistry,
  storageRefScheme,
} from './storage/storage-adapter';

/** Images per batch: each travels as an image block in the tool result. */
export const IMAGES_PER_BATCH = 4;

/**
 * The longest edge an image is handed to the agent at. Vision models read
 * text in an image at about this size and gain nothing above it, and the
 * result of `take_memory_work` stays a few hundred kilobytes per image.
 */
const MAX_EDGE_PX = 1568;

/** producerVersion of the representation an agent's reading becomes. */
export const MEDIA_READING_PRODUCER = 'harness-media-reading-v1';

const SYSTEM_PROMPT =
  "You are reading an image from a person's memory. First, copy every piece of legible text " +
  'exactly as written: numbers, codes, names, amounts and dates verbatim, one line per line of ' +
  'the image. Then describe what the image shows in a few plain sentences: what kind of image it ' +
  'is (a screenshot of an app, a photo of a receipt, a slide, a whiteboard…) and what it says or ' +
  'records. State only what is visible. Do not name or guess who a person in a photo is from ' +
  'their face. Write the description in the language of the text in the image, or in English ' +
  'when there is none. An image with no text gets an empty text.';

/** What a submitted batch of readings did. */
export interface MediaReadingOutcome {
  images: number;
  read: number;
  /** Changed, removed or already read since the batch was taken. */
  stale: number;
  missing: number;
}

interface AssetRow {
  id: unknown;
  byteHash: string;
  mediaType: string;
  modality: string;
  availability: string;
  storageRef?: string | null;
  quarantineStatus?: string | null;
}

interface PackRow {
  packId: string;
  manifest: DomainPackManifest;
  acceptedModalities?: boolean;
  acceptedModalitiesChecksum?: string | null;
}

/**
 * Harness mode (#819, #900 step 3): an image's content read by the
 * connected agent. Locally the OCR adapter reads an image's printed text;
 * what the image shows — a chart, a photo of a whiteboard, a screenshot's
 * layout — needs a vision model, which a keyless server does not have and
 * the connected agent does. The agent receives each image (downscaled) as
 * an image block and returns its text and a description; the reading is
 * stored as the asset's `text` representation and handed to the evidence →
 * document bridge like any other reading, so its facts carry the asset as
 * provenance.
 *
 * Offered only for an image some ACTIVE pack declares an `image → text`
 * processor need for, with current modality consent (the dispatch gate
 * every processor passes), clean of quarantine, and in the caller's user
 * scope. An image is offered once: a reading is not re-offered.
 */
@Injectable()
export class MediaReadingWorkService {
  private readonly logger = new Logger(MediaReadingWorkService.name);

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly store: EvidenceStoreService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS) private readonly storage: EvidenceStorageRegistry,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    const max = Math.max(1, Math.min(opts.max ?? IMAGES_PER_BATCH, IMAGES_PER_BATCH));
    const { assets, packs } = await this.pending(companyId, opts.userId, max * 4);
    const picked: Array<{ asset: AssetRow; packId: string; jpeg: Buffer }> = [];
    for (const asset of assets) {
      if (picked.length >= max) break;
      const packId = consentingPack(packs, asset);
      if (!packId) continue;
      const jpeg = await this.downscaled(asset);
      if (jpeg) picked.push({ asset, packId, jpeg });
    }
    if (picked.length === 0) return null;
    const exp = workExpiry();
    const payload: MediaTokenPayload = {
      v: 2,
      t: 'media_reading',
      c: companyId,
      ...(opts.userId !== undefined ? { u: opts.userId } : {}),
      a: picked.map((p) => [String(p.asset.id), p.asset.byteHash, p.packId]),
      n: workNonce(),
      exp,
    };
    this.logger.log(`harness work taken ${companyId}: media_reading images=${picked.length}`);
    return {
      kind: 'media_reading',
      token: mintWorkToken(payload),
      systemPrompt: batchInstructions('image', 'i') + SYSTEM_PROMPT,
      userContent: picked
        .map((_, i) => `Image i${i + 1} is the image block number ${i + 1} after this text.`)
        .join('\n'),
      images: picked.map((p) => ({ data: p.jpeg.toString('base64'), mimeType: 'image/jpeg' })),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                image: { type: 'string', description: 'The image number, "i1", "i2", …' },
                text: { type: 'string', description: 'Every legible text, verbatim' },
                description: { type: 'string', description: 'What the image shows' },
              },
              required: ['image', 'text', 'description'],
            },
          },
        },
        required: ['images'],
      },
      items: picked.length,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async submit(
    companyId: string,
    payload: MediaTokenPayload,
    result: unknown,
  ): Promise<MediaReadingOutcome> {
    const list = (result as { images?: unknown } | null)?.images;
    if (!Array.isArray(list)) {
      throw new BadRequestException('result.images must be an array of {image, text, description}');
    }
    const readings = new Map<string, string>();
    for (const r of list as Array<{ image?: unknown; text?: unknown; description?: unknown }>) {
      if (typeof r?.image !== 'string') continue;
      const key = r.image.trim().toLowerCase();
      if (!readings.has(key)) readings.set(key, readingText(r.text, r.description));
    }
    const out: MediaReadingOutcome = { images: payload.a.length, read: 0, stale: 0, missing: 0 };
    for (const [i, [assetId, byteHash, packId]] of payload.a.entries()) {
      const content = readings.get(`i${i + 1}`);
      if (content === undefined) {
        out.missing += 1;
        continue;
      }
      if (!(await this.stillUnread(companyId, assetId, byteHash))) {
        out.stale += 1;
        continue;
      }
      // An image with nothing in it is still recorded as read, so it is not
      // offered again; the bridge skips empty text.
      const { representationId } = await this.store.addRepresentation(companyId, {
        subjectId: assetId,
        subjectKind: 'asset',
        kind: 'text',
        content,
        model: 'connected-agent',
        producerVersion: MEDIA_READING_PRODUCER,
      });
      out.read += 1;
      if (content.length > 0) await this.bridge(companyId, { assetId, representationId, packId });
    }
    this.logger.log(
      `harness work submitted ${companyId}: media_reading images=${out.images} read=${out.read} stale=${out.stale}`,
    );
    return out;
  }

  /** Hot, clean images in the caller's scope with no agent reading yet, and the active packs. */
  private async pending(
    companyId: string,
    userId: string | undefined,
    limit: number,
  ): Promise<{ assets: AssetRow[]; packs: PackRow[] }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [assets, packs] = await db.query<[AssetRow[], PackRow[]]>(
        `SELECT id, byteHash, mediaType, modality, availability, storageRef, quarantineStatus, createdAt
           FROM evidence_asset
          WHERE modality = 'image' AND availability = 'hot'
            AND (quarantineStatus IS NONE OR quarantineStatus = 'clean')
            AND ${userId === undefined ? 'userId IS NONE' : 'userId = $u'}
            AND count((SELECT id FROM derived_representation
                        WHERE subjectId = $parent.id AND producerVersion = $pv LIMIT 1)) = 0
          ORDER BY createdAt ASC LIMIT $k;
         SELECT packId, manifest, acceptedModalities, acceptedModalitiesChecksum
           FROM domain_pack WHERE status = 'active';`,
        { u: userId, pv: MEDIA_READING_PRODUCER, k: limit },
      );
      return { assets: assets ?? [], packs: packs ?? [] };
    });
  }

  /** The image as a JPEG no longer than MAX_EDGE_PX, or null when its bytes cannot be read. */
  private async downscaled(asset: AssetRow): Promise<Buffer | null> {
    const ref = asset.storageRef ?? '';
    const scheme = storageRefScheme(ref);
    const adapter = scheme ? this.storage.get(scheme) : undefined;
    if (!adapter) return null;
    try {
      const bytes = await readBoundedStream(await adapter.get(ref), evidenceMaxBytes());
      return await sharp(bytes, { failOn: 'error' })
        .rotate()
        .resize({
          width: MAX_EDGE_PX,
          height: MAX_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(
        `media reading skipped ${String(asset.id)}: ${err instanceof Error ? err.message : 'unreadable'}`,
      );
      return null;
    }
  }

  /** The asset still holds the bytes the agent was shown, and no reading has landed since. */
  private async stillUnread(
    companyId: string,
    assetId: string,
    byteHash: string,
  ): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count((SELECT id FROM derived_representation
                        WHERE subjectId = $parent.id AND producerVersion = $pv LIMIT 1)) AS n
           FROM type::record('evidence_asset', $tail)
          WHERE byteHash = $hash AND availability != 'gone'`,
        { tail: idTailOf(assetId), hash: byteHash, pv: MEDIA_READING_PRODUCER },
      );
      return rows?.[0]?.n === 0;
    });
  }

  /** The evidence → document bridge, through the queue (the broker's seam). */
  private async bridge(
    companyId: string,
    p: { assetId: string; representationId: string; packId: string },
  ): Promise<void> {
    if (!this.claim || !evidenceDocumentBridgeEnabled()) return;
    await this.claim.enqueue({
      jobType: 'evidence_document_bridge',
      companyId,
      triggeredBy: 'manual',
      dedupKey: `evbridge_${idTailOf(p.assetId)}_${idTailOf(p.representationId)}`,
      payload: p,
    });
  }
}

/** The first active pack whose consent covers reading this image into text. */
function consentingPack(packs: PackRow[], asset: AssetRow): string | undefined {
  return packs.find(
    (pack) =>
      gateProcessorDispatch({
        manifest: pack.manifest,
        acceptedModalities: pack.acceptedModalities === true,
        acceptedModalitiesChecksum: pack.acceptedModalitiesChecksum ?? null,
        capability: 'text',
        asset: {
          modality: asset.modality as EvidenceModality,
          availability: asset.availability,
          quarantineStatus: asset.quarantineStatus,
        },
      }).allowed,
  )?.packId;
}

/** The stored reading: the image's text, then what it shows. */
export function readingText(text: unknown, description: unknown): string {
  const t = typeof text === 'string' ? text.trim() : '';
  const d = typeof description === 'string' ? description.trim() : '';
  return [t, d].filter((s) => s.length > 0).join('\n\n');
}
