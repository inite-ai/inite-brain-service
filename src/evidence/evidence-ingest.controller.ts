import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { PolicyAction } from '../policy/action-registry';
import { evidenceBlobUploadEnabled, evidenceIngestEnabled } from '../common/evidence-flags';
import {
  EVIDENCE_BLOB_FIELD,
  EvidenceBlobUploadInterceptor,
  type UploadedEvidenceBlob,
} from './blob-upload.interceptor';
import { EvidenceStoreService } from './evidence-store.service';
import { EvidenceUploadService, type UploadEvidenceBlobResult } from './evidence-upload.service';
import { validateLocator } from './locator';
import { IngestEvidenceAssetDto, IngestEvidenceFragmentDto } from './dto/ingest-evidence-asset.dto';
import { UploadEvidenceBlobDto } from './dto/upload-evidence-blob.dto';

/**
 * Producer stamp for caller-asserted fragment excerpts: the "producer"
 * is this ingest surface relaying the caller's quotation — not a model
 * (model / modelVersion / promptVersion stay absent on purpose).
 */
export const INGEST_EXCERPT_PRODUCER = 'ingest-excerpt-v1';

export interface IngestEvidenceFragmentResult {
  fragmentId: string;
  /** Present when the fragment carried an excerpt. */
  representationId?: string;
}

export interface IngestEvidenceAssetResult {
  assetId: string;
  availability: string;
  deduped: boolean;
  fragments: IngestEvidenceFragmentResult[];
}

/**
 * The evidence substrate's two write-side HTTP surfaces, each behind its
 * own flag and each honest about whether bytes change hands.
 *
 * POST /v1/ingest/evidence-asset (Brain v2.1 M3) is METADATA-ONLY by
 * design (the MM-6 quarantine boundary): the caller registers what an
 * observation IS (modality, mediaType, byteHash identity, dimensions) and
 * WHERE it lives (`originUri`, never fetched) — no bytes cross it and
 * `storageRef` is rejected by the forbidNonWhitelisted pipe, so a fresh
 * registration is always availability='external'.
 *
 * POST /v1/ingest/evidence-blob (Brain v2.1 MM-7) is the byte surface:
 * `multipart/form-data`, the bytes stored content-addressed through the
 * storage adapter, availability DERIVED as 'hot', and the asset scanned
 * before it is dispatchable. Because bytes arriving over HTTP are
 * external ingest by definition, it registers with origin
 * 'external_ingest' and therefore inherits the MM-6 fence: without
 * EVIDENCE_QUARANTINE the store refuses (503) and nothing is written.
 * The server owns byteHash / byteLength / storageRef there — a caller
 * that hands over the bytes cannot also assert what they are.
 *
 * Both routes are dark by default (EVIDENCE_INGEST_ENABLED and
 * EVIDENCE_BLOB_UPLOAD_ENABLED, independently — a deployment may take
 * bytes without opening caller-asserted registration, or the reverse) and
 * answer a bare 404 when off, the scenes-surface precedent; prod stays
 * byte-identical. Both additionally need EVIDENCE_SUBSTRATE_ENABLED at
 * the write seam (off → 503; env-validation warns at boot on the
 * inconsistent pair). All flags read at call time (runtime-mutable).
 *
 * Semantics inherited from the ONE write seam (EvidenceStoreService):
 * same-user re-registration of a known byteHash dedupes
 * (`deduped: true`) and still appends the requested fragments (0109
 * deliberately has no UNIQUE (assetId, locator) pair — a retry appends);
 * a different principal hitting an existing hash gets a bare 409 without
 * the stored row's metadata (dedup-probe leak stays closed). Every
 * fragment locator is validated against the kind→modality matrix BEFORE
 * any row is written — one bad locator fails the whole request.
 */
@Controller('v1/ingest')
@UseGuards(ApiKeyGuard)
export class EvidenceIngestController {
  constructor(
    private readonly store: EvidenceStoreService,
    private readonly uploads: EvidenceUploadService,
  ) {}

  @Post('evidence-asset')
  @RequireScopes('brain:write')
  @PolicyAction('rest.ingest.evidence_asset')
  async ingestEvidenceAsset(
    @Req() req: AuthenticatedRequest,
    @Body() body: IngestEvidenceAssetDto,
  ): Promise<IngestEvidenceAssetResult> {
    if (!evidenceIngestEnabled()) throw new NotFoundException();
    this.validateFragments(body);
    const companyId = req.brainAuth.companyId;
    // Composition with 0121/0122 (deliberate, not an omission):
    //  - `origin` stays the default 'internal' — origin means "where the
    //    BYTES came from", and this surface never takes bytes into
    //    custody ('external_ingest' + the quarantine seam govern
    //    byte-backed ingestion, which stays service-level);
    //  - the initial ownership evidence_grant is created BY registerAsset
    //    itself (user-owned when userId is present, system-owned
    //    otherwise; the dedup path re-ensures a live grant) — nothing to
    //    add here.
    const asset = await this.store.registerAsset(companyId, {
      modality: body.modality,
      mediaType: body.mediaType,
      byteHash: body.byteHash,
      byteLength: body.byteLength,
      occurredAt: new Date(body.occurredAt),
      // METADATA-ONLY: originUri, never storageRef (MM-6 boundary).
      originUri: body.originUri,
      vertical: body.vertical,
      userId: body.userId,
      scope: body.scope,
      piiClasses: body.piiClasses,
      recorder: body.recorder,
      retainUntil: body.retainUntil !== undefined ? new Date(body.retainUntil) : undefined,
      meta: body.meta,
      width: body.width,
      height: body.height,
      durationMs: body.durationMs,
      pageCount: body.pageCount,
    });
    const fragments: IngestEvidenceFragmentResult[] = [];
    for (const frag of body.fragments ?? []) {
      fragments.push(await this.writeFragment(companyId, asset.assetId, frag));
    }
    return {
      assetId: asset.assetId,
      availability: asset.availability,
      deduped: asset.deduped,
      fragments,
    };
  }

  /**
   * The byte surface. Same guard, same `brain:write` scope and same
   * tenant fence as its metadata sibling — `companyId` comes from the
   * authenticated key, never from the multipart body, so a caller cannot
   * name a tenant. Its own ABAC action (`rest.ingest.evidence_blob`) so a
   * policy can open metadata registration without also opening byte
   * custody.
   *
   * The flag is checked TWICE on purpose: the interceptor throws first
   * (before multer buffers anything, and before parameter pipes could
   * turn an unparsed body into a route-revealing 400), and this line is
   * the seam a unit test can pin without a multipart fixture.
   */
  @Post('evidence-blob')
  @RequireScopes('brain:write')
  @PolicyAction('rest.ingest.evidence_blob')
  @UseInterceptors(EvidenceBlobUploadInterceptor)
  async uploadEvidenceBlob(
    @Req() req: AuthenticatedRequest,
    @Body() body: UploadEvidenceBlobDto,
    @UploadedFile() file?: UploadedEvidenceBlob,
  ): Promise<UploadEvidenceBlobResult> {
    if (!evidenceBlobUploadEnabled()) throw new NotFoundException();
    if (!file) throw new BadRequestException(`a '${EVIDENCE_BLOB_FIELD}' file part is required`);
    return this.uploads.upload(req.brainAuth.companyId, file, {
      modality: body.modality,
      mediaType: body.mediaType,
      occurredAt: new Date(body.occurredAt),
      vertical: body.vertical,
      userId: body.userId,
      scope: body.scope,
      piiClasses: body.piiClasses,
      recorder: body.recorder,
      retainUntil: body.retainUntil !== undefined ? new Date(body.retainUntil) : undefined,
      width: body.width,
      height: body.height,
      durationMs: body.durationMs,
      pageCount: body.pageCount,
      packId: body.packId,
    });
  }

  /**
   * Pre-write validation: every locator against the request's modality
   * (validateLocator is pure — same checker the write seam runs), plus
   * the excerpt blank-check. Failing HERE means a 400 writes NOTHING —
   * without it a bad third fragment would leave an asset plus two
   * fragments behind.
   */
  private validateFragments(body: IngestEvidenceAssetDto): void {
    (body.fragments ?? []).forEach((frag, i) => {
      const err = validateLocator(body.modality, frag.locator);
      if (err) throw new BadRequestException(`fragments[${i}].locator: ${err}`);
      if (frag.excerpt !== undefined && frag.excerpt.trim() === '') {
        throw new BadRequestException(`fragments[${i}].excerpt must not be blank`);
      }
    });
  }

  /** One fragment row + its optional caller-asserted text excerpt. */
  private async writeFragment(
    companyId: string,
    assetId: string,
    frag: IngestEvidenceFragmentDto,
  ): Promise<IngestEvidenceFragmentResult> {
    const { fragmentId } = await this.store.addFragment(companyId, {
      assetId,
      locator: frag.locator,
      label: frag.label,
      piiClasses: frag.piiClasses,
    });
    if (frag.excerpt === undefined) return { fragmentId };
    const { representationId } = await this.store.addRepresentation(companyId, {
      subjectId: fragmentId,
      subjectKind: 'fragment',
      kind: 'text',
      content: frag.excerpt,
      lang: frag.lang,
      producerVersion: INGEST_EXCERPT_PRODUCER,
    });
    return { fragmentId, representationId };
  }
}
