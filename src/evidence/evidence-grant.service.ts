import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { mediaPiiAllowed } from '../common/media-pii';
import { SurrealService, queryFirst, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import type {
  EvidenceGrantRow,
  GrantEvidenceAccessRequest,
} from '../contracts/evidence/grants.schema';
import { EvidenceStoreService } from './evidence-store.service';

/** Bound on a caller-supplied record id before it reaches the DB. Over
 *  the cap is NOT a distinguishable error — the id is simply replaced by
 *  the sentinel below, so a malformed probe walks the same path as a
 *  well-formed miss. */
const RECORD_ID_MAX = 256;

/** Tail used when a caller's id is malformed, or when a grant lookup
 *  found nothing and the ladder must still run: `type::record()` over it
 *  is a syntactically valid record id that no writer can ever mint (every
 *  id in these tables is a ULID or a 32-hex digest), so the ladder issues
 *  the SAME queries against the SAME indexes and finds nothing. */
const ABSENT_TAIL = '__absent__';

/** Who is asking — the authenticated slice the ladder fences on. */
export interface GrantCaller {
  scopes: readonly string[];
  /** End-user of a user-bound token; absent for M2M credentials. */
  userId?: string | undefined;
}

interface AssetLadderRow {
  id: unknown;
  availability?: string | undefined;
  quarantineStatus?: string | null | undefined;
  piiClasses?: string[] | null | undefined;
  retainUntil?: string | Date | null | undefined;
}

/** What the ladder resolved — enough to act, and nothing about bytes. */
interface GrantSubject {
  assetIdStr: string;
  retainUntil: string | null;
}

/**
 * EvidenceGrantService — the authorization half of the sharing surface
 * (Brain v2.1 MM-4, migration 0122). The controller keeps transport; the
 * write seam (EvidenceStoreService.addGrant / revokeGrant / liveGrants)
 * keeps persistence; this service owns the ONE question both of them
 * refuse to answer on their own: may THIS caller act on THIS asset?
 *
 * WHY THE SURFACE WAS WITHHELD. 0122 shipped the grant machinery
 * service-only with an explicit note — "callers are authorized code
 * paths, never a hash-probing client". A sharing route is the natural
 * home of an existence oracle: hand it an id (or, worse, a content hash)
 * and let the status code say whether those bytes exist in this tenant.
 * registerAsset already closes the hash half by answering a bare 409
 * without the stored row's metadata; this ladder closes the id half.
 *
 * THE LADDER (deny-overrides, evaluated over rows already fetched):
 *   (1) tenant fence — every lookup runs inside withCompany(companyId),
 *       so a foreign asset is simply not found;
 *   (2) liveness — availability != 'gone', quarantineStatus clean or
 *       absent (0121: nothing writes a status while the seam is off),
 *       and retainUntil not already past (an asset the sweeper owes a
 *       tombstone must not be re-shared: a grant may not outlive the
 *       asset's own retention policy);
 *   (3) ownership — the raw-read gateway's own fence, verbatim: at least
 *       one live grant must exist, and a USER-BOUND key must hold the
 *       end user's own live user grant (0055/0093). Nobody grants what
 *       they do not hold;
 *   (4) media PII — the polarity gate of src/common/media-pii.ts over
 *       the asset's classes: unclassified blocked, `[]` open, classified
 *       needs brain:read_media. Nobody shares what they cannot see.
 * Every failure is the SAME bare 404 — the caller cannot tell "no such
 * asset" from "not yours" from "PII-blocked".
 *
 * WHAT THE LADDER DELIBERATELY OMITS vs the raw-read ladder: the
 * byte-delivery steps (availability='hot' and the blob head) and the
 * pack modality-consent fold. Those govern whether ORIGINAL BYTES may
 * leave the service, and no byte moves here — an ownership row over an
 * `external` (metadata-only) or not-yet-hot asset is legitimate and
 * grants strictly nothing extra, because every serve re-runs the full
 * gateway ladder (consent included) against the grantee. Consent is a
 * tenant-level serving switch, not an ownership fact: folding it in
 * would make sharing impossible for tenants whose packs declare no raw
 * evidence, while granting no additional safety — the bytes stay shut
 * either way.
 *
 * TIMING. The two round-trips (asset row, live grants) are issued
 * UNCONDITIONALLY, in the same order, against the same indexes, for
 * every outcome — a missing asset probes the grant index with a record
 * id that matches nothing rather than short-circuiting. So the deny
 * classes are not separable by query count or query shape. This is a
 * structural equalization, not a constant-time guarantee: a statistical
 * attacker with enough samples can still see row-count differences.
 */
@Injectable()
export class EvidenceGrantService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly store: EvidenceStoreService,
  ) {}

  /**
   * Share an asset with one more owner. Idempotent over the live
   * (asset, ownerKind, ownerId) triple — the write seam's own dedup, so
   * a retry returns the standing row with `created: false`.
   */
  async grant(
    companyId: string,
    caller: GrantCaller,
    input: GrantEvidenceAccessRequest & { assetId: string },
  ): Promise<{ grantId: string; created: boolean; assetId: string; retainUntil: string | null }> {
    const subject = await this.resolveAsset(companyId, caller, input.assetId);
    const written = await this.uniform(
      this.store.addGrant(companyId, {
        assetId: subject.assetIdStr,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        // 'share' is what this surface does; the seam keeps the tag open
        // vocabulary, so an explicit purpose always wins.
        purpose: input.purpose ?? 'share',
      }),
    );
    return { ...written, assetId: subject.assetIdStr, retainUntil: subject.retainUntil };
  }

  /**
   * Take an ownership row back. Idempotent: an already-revoked grant
   * answers exactly like a freshly revoked one (the seam keeps the
   * original revokedAt for audit), so a retry is indistinguishable from
   * the first call — and so is a probe for a revoked grant's id.
   *
   * Co-equal ownership (the 0122 model): the ladder runs over the
   * grant's OWN asset, so any owner may revoke any grant on it —
   * including the last one, which is how an asset is administratively
   * killed. Revocation only ever REMOVES access, and the row survives
   * with its timestamp as the audit trail of who lost what.
   */
  async revoke(
    companyId: string,
    caller: GrantCaller,
    grantId: string,
  ): Promise<{ grantId: string; revoked: true }> {
    const resolved = await this.surreal.withCompany(companyId, async (db) => {
      const grant = await queryFirst<{ id: unknown; assetId: unknown }>(
        db,
        `SELECT id, assetId FROM type::record('evidence_grant', $tail) LIMIT 1`,
        { tail: tailOf(grantId, 'evidence_grant') },
      );
      // The ladder runs either way — an unknown grant id costs the same
      // two round-trips as one that exists but is not the caller's.
      const subject = await this.ladder(
        db,
        grant ? tailOf(String(grant.assetId), 'evidence_asset') : ABSENT_TAIL,
        caller,
      );
      return grant && subject ? String(grant.id) : null;
    });
    if (resolved === null) throw new NotFoundException();
    await this.uniform(this.store.revokeGrant(companyId, resolved));
    return { grantId: resolved, revoked: true };
  }

  /**
   * The asset's LIVE owners. Grantee handles are ownership facts about
   * other principals, so they reach only a caller the ladder recognized
   * as an owner; everyone else gets the same bare 404 as for an asset
   * that does not exist. Revoked rows stay off the wire — they are audit
   * (a revoked grant still names its owner), not a directory.
   */
  async list(
    companyId: string,
    caller: GrantCaller,
    assetId: string,
  ): Promise<{ assetId: string; grants: EvidenceGrantRow[] }> {
    const subject = await this.resolveAsset(companyId, caller, assetId);
    const rows = await this.store.liveGrants(companyId, subject.assetIdStr);
    return {
      assetId: subject.assetIdStr,
      grants: rows.map((r) => ({
        grantId: r.grantId,
        ownerKind: asOwnerKind(r.ownerKind),
        ownerId: r.ownerId,
        ...(r.purpose !== undefined ? { purpose: r.purpose } : {}),
        grantedAt: isoOf(r.grantedAt) ?? new Date(0).toISOString(),
      })),
    };
  }

  /** Ladder over a caller-named asset id; the uniform 404 on any deny. */
  private async resolveAsset(
    companyId: string,
    caller: GrantCaller,
    assetId: string,
  ): Promise<GrantSubject> {
    const subject = await this.surreal.withCompany(companyId, (db) =>
      this.ladder(db, tailOf(assetId, 'evidence_asset'), caller),
    );
    if (!subject) throw new NotFoundException();
    return subject;
  }

  /** The four steps (see the class doc). Both queries always run. */
  private async ladder(
    db: Surreal,
    assetTail: string,
    caller: GrantCaller,
  ): Promise<GrantSubject | null> {
    const row = await queryFirst<AssetLadderRow>(
      db,
      `SELECT id, availability, quarantineStatus, piiClasses, retainUntil
         FROM type::record('evidence_asset', $tail) LIMIT 1`,
      { tail: assetTail },
    );
    const live = await queryRows<{ ownerKind: string; ownerId: string }>(
      db,
      `SELECT ownerKind, ownerId FROM evidence_grant
        WHERE assetId = type::record('evidence_asset', $tail) AND revokedAt = NONE`,
      { tail: assetTail },
    );
    // Pure decisions over rows already in hand — no branch below issues
    // I/O, so the deny classes stay indistinguishable (class doc).
    if (!row) return null;
    if (!aliveForSharing(row)) return null;
    if (!ownedByCaller(live, caller.userId)) return null;
    if (!mediaPiiAllowed(row.piiClasses, caller.scopes)) return null;
    return { assetIdStr: String(row.id), retainUntil: isoOf(row.retainUntil) };
  }

  /**
   * Seam errors that would otherwise DESCRIBE the subject are flattened
   * into the same bare 404 the ladder throws: a NotFound (the row died
   * between the ladder and the write) or a Conflict (it was tombstoned
   * in the same window) both carry a message naming the asset, which is
   * exactly the oracle this surface exists to withhold. Everything else
   * — the store's 503 write gate above all — passes through untouched.
   */
  private async uniform<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof ConflictException) {
        throw new NotFoundException();
      }
      throw e;
    }
  }
}

/**
 * Step 2 currency. NOT the raw gateway's `availability === 'hot'`: bytes
 * are not moving, so a metadata-only ('external') or cold observation is
 * shareable — only a tombstoned one is not. Quarantine keeps the read
 * path's polarity exactly (clean or absent), because an unscanned or
 * rejected asset must not spread to new owners. `retainUntil` in the
 * past means the retention sweep owes this asset a tombstone: refuse
 * rather than let a grant outlive the asset's own policy.
 */
function aliveForSharing(row: AssetLadderRow): boolean {
  if (row.availability === 'gone') return false;
  const q = row.quarantineStatus;
  if (!(q === undefined || q === null || q === 'clean')) return false;
  const until = row.retainUntil == null ? null : new Date(row.retainUntil).getTime();
  return until === null || Number.isNaN(until) || until > Date.now();
}

/** Step 3 currency — EvidenceReadService.grantOk, verbatim: an asset with
 *  no live grant is administratively dead for everyone, and a user-bound
 *  key must additionally hold its own user grant (0055). */
function ownedByCaller(
  live: ReadonlyArray<{ ownerKind: string; ownerId: string }>,
  userId: string | undefined,
): boolean {
  if (live.length === 0) return false;
  if (userId === undefined) return true;
  return live.some((g) => g.ownerKind === 'user' && g.ownerId === userId);
}

/** Caller-supplied record id → its tail, or the never-matching sentinel
 *  when the id is not a well-formed reference to `table`. A malformed id
 *  is answered by the ladder's uniform 404, never by a distinguishable
 *  400 — the shape of an id space is not a thing this surface teaches. */
function tailOf(recordId: string, table: string): string {
  if (recordId.length > RECORD_ID_MAX || !recordId.startsWith(`${table}:`)) return ABSENT_TAIL;
  const tail = idTailOf(recordId);
  return tail === '' ? ABSENT_TAIL : tail;
}

/** Datetime column → ISO string; absent/unparsable → null. */
function isoOf(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The stored ownerKind narrowed to the wire union; 0122's ASSERT keeps
 *  the column inside it, so anything else is a corrupted row and reads
 *  as the most restrictive kind rather than widening the contract. */
function asOwnerKind(kind: string): 'user' | 'pack' | 'system' {
  return kind === 'user' || kind === 'pack' ? kind : 'system';
}
