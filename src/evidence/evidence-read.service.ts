import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import type { DomainPackManifest } from '../ai/domain-packs';
import { strictestPiiUnion } from '../common/media-pii';
import { SurrealService, dbCreate, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { gateRawEvidence } from '../mcp/raw-evidence-gate';
import type { EvidenceTokenPayload } from './raw-url-token';
import {
  EVIDENCE_STORAGE_ADAPTERS,
  EvidenceStorageRegistry,
  storageRefScheme,
} from './storage/storage-adapter';

/** Caller-supplied subject handles are audited verbatim — bounded so a
 *  probe cannot bloat the content-free audit table (0048 cap doctrine). */
const HANDLE_MAX = 200;

export type AccessVerb = 'stream' | 'mint' | 'redeem';

/** What the gate ladder resolved — enough to stream or mint, no bytes. */
export interface SubjectBlob {
  assetIdStr: string;
  fragmentIdStr?: string | undefined;
  storageRef: string;
  mediaType: string;
  byteLength: number;
}

interface AssetRow {
  id: unknown;
  availability?: string | undefined;
  quarantineStatus?: string | null | undefined;
  storageRef?: string | undefined;
  mediaType?: string | undefined;
  byteLength?: number | undefined;
  piiClasses?: string[] | null | undefined;
}

interface FragmentRow extends AssetRow {
  fragmentPiiClasses?: string[] | null | undefined;
  assetIdStr?: string | undefined;
}

interface ConsentRow {
  manifest?: unknown;
  acceptedModalities?: unknown;
  acceptedModalitiesChecksum?: unknown;
}

interface AuditKey {
  assetId: string;
  fragmentId?: string | undefined;
  keyHash: string;
  verb: AccessVerb;
}

/**
 * EvidenceReadService — the DB half of the raw-read gateway (MM-3):
 * the gate-ladder steps that touch rows (tenant fence, live grants,
 * modality consent, media PII, blob head) plus the content-free
 * evidence_access audit writes (migration 0125). The controller keeps
 * transport (routes, token mint/verify, headers, streaming) — layer
 * purity: controllers never import src/db.
 *
 * Ladder semantics (deny-overrides, first failure wins; the numbering
 * follows the controller's class doc):
 *   (2) tenant fence — the lookup runs inside withCompany(companyId),
 *       so a foreign asset is simply not found; availability must be
 *       'hot' and quarantineStatus clean-or-absent (0121: nothing
 *       writes a non-clean status while the seam is off, so absent
 *       reads as legacy-clean)                    → denied_tenant /
 *       denied_availability
 *   (3) grants (0122) — ≥1 live row keeps the asset servable at all
 *       (all-revoked = administratively dead, the redeem backstop
 *       applied to first-party reads); a USER-BOUND key must ALSO hold
 *       the end user's own live user-grant (0055)  → denied_grant
 *   (5) modality consent — gateRawEvidence (its FIRST production call
 *       site) folded over a DIRECT domain_pack read: deliberately NOT
 *       the fail-open MemoryModelReaderService cache — raw bytes must
 *       not serve on a stale cache entry after consent was withdrawn,
 *       and a read failure must deny, never default. Probed with
 *       `fragmentPiiClasses: []` so only clauses (a)+(b) decide
 *                                                  → denied_consent
 *   (6) media PII — the SAME gate re-run with the row's real classes
 *       (strictest fragment+asset union on the fragment twins): two
 *       calls, zero duplicated logic, distinguishable audit outcomes
 *                                                  → denied_pii
 *   (7) blob head through the scheme adapter       → denied_blob
 * Every deny is recorded (best-effort) and surfaced as the SAME bare
 * 404 — no existence oracle. The 'ok' row is written BEFORE the blob
 * ref leaves this service and is NOT best-effort: if the audit write
 * fails, the serve fails — no unaccounted byte ever leaves.
 */
@Injectable()
export class EvidenceReadService {
  private readonly logger = new Logger(EvidenceReadService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Inject(EVIDENCE_STORAGE_ADAPTERS)
    private readonly adapters: EvidenceStorageRegistry,
  ) {}

  /** Steps 2/3/5/6/7 for the four authenticated routes. */
  async runLadder(opts: {
    companyId: string;
    scopes: readonly string[];
    keyHash: string;
    userId?: string | undefined;
    assetId?: string | undefined;
    fragmentId?: string | undefined;
    verb: AccessVerb;
  }): Promise<SubjectBlob> {
    return this.surreal.withCompany(opts.companyId, async (db) => {
      const row = opts.fragmentId
        ? await this.loadFragment(db, opts.fragmentId)
        : await this.loadAsset(db, opts.assetId ?? '');
      const audit: AuditKey = {
        assetId: (row?.assetIdStr ?? opts.assetId ?? '').slice(0, HANDLE_MAX),
        fragmentId: opts.fragmentId?.slice(0, HANDLE_MAX),
        keyHash: opts.keyHash,
        verb: opts.verb,
      };
      if (!row) throw await this.deny(db, audit, 'denied_tenant');
      if (!availabilityOk(row)) throw await this.deny(db, audit, 'denied_availability');
      if (!(await this.grantOk(db, row.id, opts.userId))) {
        throw await this.deny(db, audit, 'denied_grant');
      }
      const consent = await this.consentingManifest(db, opts.scopes);
      if (!consent) throw await this.deny(db, audit, 'denied_consent');
      const pii = opts.fragmentId
        ? strictestPiiUnion(row.fragmentPiiClasses, row.piiClasses)
        : row.piiClasses;
      if (!gateRawEvidence({ ...consent, fragmentPiiClasses: pii }).allowed) {
        throw await this.deny(db, audit, 'denied_pii');
      }
      const blob = blobOf(row, audit.assetId, audit.fragmentId);
      if (!blob || !(await this.blobExists(blob.storageRef))) {
        throw await this.deny(db, audit, 'denied_blob');
      }
      // Accountability before bytes: NOT best-effort (class doc).
      await dbCreate(db, 'evidence_access', { ...audit, outcome: 'ok' });
      return blob;
    });
  }

  /**
   * Redeem's fail-closed re-checks — NO auth/ABAC/consent/PII re-run
   * (the token IS the capability; the controller verified its signature
   * BEFORE this runs, so the payload — tenant included — is trusted):
   * expiry, structural tenant pin (lookup inside withCompany(payload.t)),
   * availability still hot, ≥1 live grant (revocation backstop). All
   * denials are the same bare 404, distinguished only in the audit row.
   */
  async redeemLadder(payload: EvidenceTokenPayload, expired: boolean): Promise<SubjectBlob> {
    return this.surreal.withCompany(payload.t, async (db) => {
      const audit: AuditKey = {
        assetId: payload.a.slice(0, HANDLE_MAX),
        fragmentId: payload.f?.slice(0, HANDLE_MAX),
        keyHash: payload.k.slice(0, HANDLE_MAX),
        verb: 'redeem',
      };
      if (expired) throw await this.deny(db, audit, 'denied_expired');
      const row = await this.loadAsset(db, payload.a);
      if (!row) throw await this.deny(db, audit, 'denied_tenant');
      if (!availabilityOk(row)) throw await this.deny(db, audit, 'denied_availability');
      if (!(await this.grantOk(db, row.id, undefined))) {
        throw await this.deny(db, audit, 'denied_revoked');
      }
      const blob = blobOf(row, audit.assetId, audit.fragmentId);
      if (!blob || !(await this.blobExists(blob.storageRef))) {
        throw await this.deny(db, audit, 'denied_blob');
      }
      // Accountability before bytes: NOT best-effort (class doc).
      await dbCreate(db, 'evidence_access', { ...audit, outcome: 'ok' });
      return blob;
    });
  }

  private async loadAsset(db: Surreal, assetId: string): Promise<FragmentRow | null> {
    const row = await queryFirst<AssetRow>(
      db,
      `SELECT id, availability, quarantineStatus, storageRef, mediaType,
              byteLength, piiClasses
         FROM type::record('evidence_asset', $tail) LIMIT 1`,
      { tail: idTailOf(assetId) },
    );
    if (!row) return null;
    return { ...row, assetIdStr: String(row.id) };
  }

  /** Fragment twin: the PARENT asset's row fields through the record
   *  link, plus the fragment's own piiClasses for the strictest union. */
  private async loadFragment(db: Surreal, fragmentId: string): Promise<FragmentRow | null> {
    const row = await queryFirst<FragmentRow & { asset?: unknown }>(
      db,
      `SELECT id, piiClasses AS fragmentPiiClasses, assetId AS asset,
              assetId.availability AS availability,
              assetId.quarantineStatus AS quarantineStatus,
              assetId.storageRef AS storageRef,
              assetId.mediaType AS mediaType,
              assetId.byteLength AS byteLength,
              assetId.piiClasses AS piiClasses
         FROM type::record('evidence_fragment', $tail) LIMIT 1`,
      { tail: idTailOf(fragmentId) },
    );
    if (!row || row.asset === undefined || row.asset === null) return null;
    return { ...row, id: row.asset, assetIdStr: String(row.asset) };
  }

  /** Step 3 currency — see the class doc. */
  private async grantOk(db: Surreal, asset: unknown, userId: string | undefined): Promise<boolean> {
    const live = await queryRows<{ ownerKind: string; ownerId: string }>(
      db,
      `SELECT ownerKind, ownerId FROM evidence_grant
        WHERE assetId = $asset AND revokedAt = NONE`,
      { asset },
    );
    if (live.length === 0) return false;
    if (userId === undefined) return true;
    return live.some((g) => g.ownerKind === 'user' && g.ownerId === userId);
  }

  /** Step 5 fold — see the class doc. Returns the consenting pack's
   *  gate inputs (reused verbatim by the step-6 re-run), or null. */
  private async consentingManifest(
    db: Surreal,
    scopes: readonly string[],
  ): Promise<{
    manifest: DomainPackManifest;
    acceptedModalities: boolean;
    acceptedModalitiesChecksum: string | null;
    callerScopes: readonly string[];
  } | null> {
    let rows: ConsentRow[];
    try {
      const [r] = await db.query<[ConsentRow[]]>(
        `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum FROM domain_pack`,
      );
      rows = r ?? [];
    } catch (e) {
      this.logger.warn(`raw-evidence consent read failed (fail closed): ${(e as Error).message}`);
      return null;
    }
    for (const row of rows) {
      try {
        if (typeof row.manifest !== 'object' || row.manifest === null) continue;
        const candidate = {
          manifest: row.manifest as DomainPackManifest,
          acceptedModalities: row.acceptedModalities === true,
          acceptedModalitiesChecksum:
            typeof row.acceptedModalitiesChecksum === 'string'
              ? row.acceptedModalitiesChecksum
              : null,
          callerScopes: scopes,
        };
        if (gateRawEvidence({ ...candidate, fragmentPiiClasses: [] }).allowed) {
          return candidate;
        }
      } catch {
        // Malformed manifest row — not consent (hasCurrentModalityConsent mold).
      }
    }
    return null;
  }

  private async blobExists(storageRef: string): Promise<boolean> {
    try {
      const scheme = storageRefScheme(storageRef);
      const adapter = scheme ? this.adapters.get(scheme) : undefined;
      if (!adapter) return false;
      return (await adapter.head(storageRef)) !== null;
    } catch (e) {
      this.logger.warn(`raw-evidence blob head failed for ${storageRef}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Record a denial (best-effort — a warn must not turn the uniform 404
   *  into a 500) and hand back the bare 404 the caller throws. */
  private async deny(db: Surreal, audit: AuditKey, outcome: string): Promise<NotFoundException> {
    try {
      await dbCreate(db, 'evidence_access', { ...audit, outcome });
    } catch (e) {
      this.logger.warn(`evidence_access denial write failed (${outcome}): ${(e as Error).message}`);
    }
    return new NotFoundException();
  }
}

/** Step 2 currency — hot + quarantine clean-or-absent (class doc). */
function availabilityOk(row: AssetRow): boolean {
  if (row.availability !== 'hot') return false;
  const q = row.quarantineStatus;
  return q === undefined || q === null || q === 'clean';
}

/** Step 7 shape: a servable row must carry a resolvable storageRef +
 *  the metadata the stream headers need. */
function blobOf(
  row: AssetRow,
  assetIdStr: string,
  fragmentIdStr: string | undefined,
): SubjectBlob | null {
  if (
    row.storageRef === undefined ||
    typeof row.mediaType !== 'string' ||
    typeof row.byteLength !== 'number'
  ) {
    return null;
  }
  return {
    assetIdStr,
    fragmentIdStr,
    storageRef: row.storageRef,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
  };
}
