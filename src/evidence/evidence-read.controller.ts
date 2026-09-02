import {
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import {
  evidenceRawReadEnabled,
  evidenceSignedUrlSecret,
  evidenceSignedUrlTtlSeconds,
} from '../common/evidence-flags';
import type { EvidenceRawUrlResponse } from '../contracts/evidence/raw.schema';
import { PolicyAction } from '../policy/action-registry';
import { EvidenceReadService, type SubjectBlob } from './evidence-read.service';
import { mintEvidenceToken, verifyEvidenceToken } from './raw-url-token';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  EvidenceStorageRegistry,
  storageRefScheme,
} from './storage/storage-adapter';

/** Minimum secret length — mirrored by the boot rule in env-validation. */
const SECRET_MIN = 32;

/**
 * EvidenceReadController (Brain v2.1 MM-3) — the ONE raw-read gateway:
 * every path that turns a stored evidence row back into original bytes
 * goes through here; nothing else in the codebase may serve a blob.
 * Transport only — the DB half of the ladder lives in
 * EvidenceReadService (layer purity: controllers never import src/db).
 *
 * Routes (all 404 while EVIDENCE_RAW_READ_ENABLED is off — the
 * EPISODES_API_ENABLED idiom, indistinguishable from absent routes):
 *   GET /v1/evidence/:assetId/raw               — stream the blob
 *   GET /v1/evidence/:assetId/raw-url           — mint a signed URL
 *   GET /v1/evidence/fragments/:fragmentId/raw      — fragment twin
 *   GET /v1/evidence/fragments/:fragmentId/raw-url  — fragment twin
 *   GET /v1/evidence/redeem/:token              — redeem a signed URL
 * The fragment twins serve WHOLE parent-asset bytes in v1 (no locator
 * cropping yet) under the STRICTEST union of fragment+asset piiClasses.
 *
 * Gate ladder — deny-overrides, first failure wins, every controller-
 * observable step lands in the content-free evidence_access audit row
 * (migration 0125):
 *   (1) ApiKeyGuard + brain:read scope            [guard]
 *   (4) ABAC action 'rest.evidence.raw'           [guard — see note]
 *   (2) tenant fence  (3) live grants  (5) modality consent
 *   (6) media PII     (7) blob head               [EvidenceReadService]
 * Note on (4): ABAC runs inside ApiKeyGuard (platform architecture —
 * every route is guard-gated before its handler), so a policy deny is a
 * 403 BEFORE the audit seam; the ladder's remaining order is exact.
 * Every deny the ladder decides is a uniform bare 404 — no existence
 * oracle; outcomes differ only inside the audit row.
 *
 * Redeem contract: NO auth / ABAC / consent / PII re-run — the token IS
 * the capability. Fail-closed re-checks only (EvidenceReadService
 * .redeemLadder): signature (timing-safe, HERE, before ANY db touch),
 * expiry, structural tenant pin, availability still hot, ≥1 live grant
 * (the revocation backstop). Bad/expired/revoked all answer the same
 * bare 404; the audit row distinguishes (denied_signature is log-only:
 * an unauthenticated forgery must not write rows into anyone's tenant).
 */
@Controller('v1/evidence')
export class EvidenceReadController {
  private readonly logger = new Logger(EvidenceReadController.name);

  constructor(
    private readonly reads: EvidenceReadService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly adapters: EvidenceStorageRegistry,
  ) {}

  private assertEnabled(): void {
    if (!evidenceRawReadEnabled()) throw new NotFoundException();
  }

  // ── Redeem (declared FIRST: '/redeem/raw' must never bind to the
  //    ':assetId/raw' pattern) — unauthenticated by design. ───────────
  @Get('redeem/:token')
  async redeem(@Param('token') token: string, @Res() res: Response): Promise<void> {
    this.assertEnabled();
    const secret = evidenceSignedUrlSecret();
    // No/short secret ⇒ nothing valid was ever minted — uniform 404.
    if (!secret || secret.length < SECRET_MIN) throw new NotFoundException();
    const verdict = verifyEvidenceToken(token, secret, Date.now());
    if (verdict.state === 'invalid') {
      // Forged/malformed: payload untrusted, so no tenant to audit into.
      this.logger.warn('raw-evidence redeem denied_signature (unsigned token)');
      throw new NotFoundException();
    }
    const blob = await this.reads.redeemLadder(verdict.payload, verdict.state === 'expired');
    await this.streamBlob(res, blob);
  }

  // ── Fragment twins (before ':assetId' so 'fragments' never binds). ──
  @Get('fragments/:fragmentId/raw')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction('rest.evidence.raw')
  async fragmentRaw(
    @Req() req: AuthenticatedRequest,
    @Param('fragmentId') fragmentId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const blob = await this.reads.runLadder({ ...ladderAuth(req), fragmentId, verb: 'stream' });
    await this.streamBlob(res, blob);
  }

  @Get('fragments/:fragmentId/raw-url')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction('rest.evidence.raw')
  async fragmentRawUrl(
    @Req() req: AuthenticatedRequest,
    @Param('fragmentId') fragmentId: string,
  ): Promise<EvidenceRawUrlResponse> {
    this.assertEnabled();
    const blob = await this.reads.runLadder({ ...ladderAuth(req), fragmentId, verb: 'mint' });
    return this.mintFor(req, blob);
  }

  // ── Asset routes. ──────────────────────────────────────────────────
  @Get(':assetId/raw')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction('rest.evidence.raw')
  async assetRaw(
    @Req() req: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const blob = await this.reads.runLadder({ ...ladderAuth(req), assetId, verb: 'stream' });
    await this.streamBlob(res, blob);
  }

  @Get(':assetId/raw-url')
  @UseGuards(ApiKeyGuard)
  @RequireScopes('brain:read')
  @PolicyAction('rest.evidence.raw')
  async assetRawUrl(
    @Req() req: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ): Promise<EvidenceRawUrlResponse> {
    this.assertEnabled();
    const blob = await this.reads.runLadder({ ...ladderAuth(req), assetId, verb: 'mint' });
    return this.mintFor(req, blob);
  }

  /** Mint the signed URL for a ladder-approved subject. 503 (operator
   *  state, the store-gate class) when the secret is absent/short —
   *  boot only WARNS on flag-without-secret, so the runtime must refuse
   *  here; the boot ERROR covers the configured-but-short shape. */
  private mintFor(req: AuthenticatedRequest, blob: SubjectBlob): EvidenceRawUrlResponse {
    const secret = evidenceSignedUrlSecret();
    if (!secret || secret.length < SECRET_MIN) {
      throw new ServiceUnavailableException(
        'EVIDENCE_SIGNED_URL_SECRET (>= 32 chars) is required to mint signed URLs',
      );
    }
    const exp = Math.floor(Date.now() / 1000) + evidenceSignedUrlTtlSeconds();
    const token = mintEvidenceToken(
      {
        v: 1,
        t: req.brainAuth.companyId,
        a: blob.assetIdStr,
        ...(blob.fragmentIdStr !== undefined ? { f: blob.fragmentIdStr } : {}),
        k: req.brainAuth.keyHash,
        exp,
      },
      secret,
    );
    return {
      token,
      url: `/v1/evidence/redeem/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Stream with the defensive header set: nosniff + no-store (spec) and
   *  attachment disposition (an API origin must never render evidence
   *  bytes as a document). mediaType was IANA-shape-validated at
   *  registration; byteLength was verified against the stored blob. */
  private async streamBlob(res: Response, blob: SubjectBlob): Promise<void> {
    const scheme = storageRefScheme(blob.storageRef);
    const adapter = scheme ? this.adapters.get(scheme) : undefined;
    if (!adapter) throw new NotFoundException();
    let stream: NodeJS.ReadableStream;
    try {
      stream = await adapter.get(blob.storageRef);
    } catch (e) {
      // head() passed inside the ladder — a vanish in between is a race
      // with GDPR/retention; the uniform 404 stands, the ok-row already
      // written records the ATTEMPT honestly (no bytes left).
      this.logger.warn(`raw-evidence blob get failed: ${(e as Error).message}`);
      throw new NotFoundException();
    }
    res.setHeader('Content-Type', blob.mediaType);
    res.setHeader('Content-Length', String(blob.byteLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment');
    stream.pipe(res);
  }
}

/** The brainAuth slice the ladder needs — one spreadable object so the
 *  route handlers stay within the max-params discipline. */
function ladderAuth(req: AuthenticatedRequest): {
  companyId: string;
  scopes: readonly string[];
  keyHash: string;
  userId?: string | undefined;
} {
  const { companyId, scopes, keyHash, userId } = req.brainAuth;
  return { companyId, scopes, keyHash, userId };
}
