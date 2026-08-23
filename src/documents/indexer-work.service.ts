import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import { IndexerRouterService } from '../indexers/indexer-router.service';
import type {
  ClaimWorkResponse,
  FailWorkResponse,
  HeartbeatWorkResponse,
  IndexerWorkListResponse,
  WorkContentResponse,
} from '../contracts/indexer/indexer-work.schema';
import { DocumentStoreService } from './document-store.service';
import {
  CandidateStoreService,
  staleRunMs,
  type RunRow,
} from './candidate-store.service';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** indexer_run projection for the external work-discovery list. */
interface WorkRow {
  id: unknown;
  docId?: unknown;
  packId?: unknown;
  packVersion?: unknown;
  createdAt?: unknown;
  docHasContent?: unknown;
}

/**
 * The pull side of the external-indexer seam (scope `indexer:write`):
 * ingest routes a document to an installed external pack and pre-creates
 * a 'pending' external indexer_run; a remote indexer discovers it here,
 * optionally claims it (CAS + claimToken lease), reads the stored
 * content, extracts, and submits through the existing
 * POST /v1/documents/:id/candidates.
 *
 * Claiming is OPTIONAL: a single-instance indexer may poll → read →
 * submit and let the submission's own createRun CAS be the claim. Fleets
 * claim first so two replicas don't extract the same document twice.
 *
 * Everything is tenant-fenced by construction (withCompany) and
 * pack-fenced against the tenant's installed external bindings — a run
 * whose pack was uninstalled is not servable work.
 */
@Injectable()
export class IndexerWorkService {
  // Work discovery spans three concerns by design: the run ledger
  // (claims), the document store (content), and the router (pack fence).
  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly candidates: CandidateStoreService,
    private readonly store: DocumentStoreService,
    private readonly router: IndexerRouterService,
  ) {}

  async listWork(p: {
    companyId: string;
    packId?: string;
    limit?: number;
    /** Per-pack binding of the calling key; absent = unrestricted. */
    keyPackIds?: string[];
  }): Promise<IndexerWorkListResponse> {
    const externalPacks = boundPacks(
      await this.externalPackIds(p.companyId),
      p.keyPackIds,
    );
    if (p.packId !== undefined) {
      assertKeyBoundToPack(p.keyPackIds, p.packId);
      this.assertExternalPack(externalPacks, p.packId);
    }
    const limit = clampLimit(p.limit);
    return this.surreal.withCompany(p.companyId, async (db) => {
      // docId.hasContent is a record-link traversal (findDocsNeedingCommit
      // precedent). ORDER BY field rides in the projection (3.x idiom).
      const rows = await queryRows<WorkRow>(
        db,
        `SELECT id, docId, packId, packVersion, createdAt,
                docId.hasContent AS docHasContent
           FROM indexer_run
           WHERE external = true AND status = 'pending'
             ${p.packId !== undefined ? 'AND packId = $pack' : ''}
           ORDER BY createdAt ASC
           LIMIT ${limit}`,
        { pack: p.packId },
      );
      const work = rows
        // An uninstalled pack's leftover rows are not servable work.
        .filter((r) => externalPacks.has(String(r.packId)))
        .map((r) => ({
          runId: String(r.id),
          documentId: String(r.docId),
          packId: String(r.packId),
          packVersion: String(r.packVersion),
          createdAt: toIso(r.createdAt),
          docHasContent: r.docHasContent === true,
        }));
      return { work };
    });
  }

  async claim(p: {
    companyId: string;
    runId: string;
    keyPackIds?: string[];
  }): Promise<ClaimWorkResponse> {
    const run = await this.getExternalRun(p.companyId, p.runId);
    assertKeyBoundToPack(p.keyPackIds, run.packId);
    this.assertExternalPack(
      await this.externalPackIds(p.companyId),
      run.packId,
    );
    const token = randomUUID();
    const claimed = await this.surreal.withCompany(p.companyId, async (db) => {
      // CAS: claimable = 'pending' (fresh work), 'failed' (reopenable —
      // a released or reaped prior attempt), or 'running' past the stale
      // window (an abandoned claim whose lease expired). A live 'running'
      // claim loses. createdAt doubles as the lease clock, exactly like
      // createRun's reopen.
      const rows = await queryRows<unknown>(
        db,
        `UPDATE type::record('indexer_run', $run) SET
           status = 'running', claimToken = $tok,
           claimedAt = time::now(), createdAt = time::now(),
           finishedAt = NONE, error = NONE, stats = NONE
         WHERE external = true AND (
           status IN ['pending', 'failed']
           OR (status = 'running'
             AND createdAt < time::now() - duration::from_millis($staleMs)))
         RETURN AFTER`,
        { run: idTailOf(p.runId), tok: token, staleMs: staleRunMs() },
      );
      return rows[0] ?? null;
    });
    if (!claimed) {
      throw new ConflictException(
        'work item is already claimed or completed',
      );
    }
    return {
      runId: run.runId,
      documentId: run.docId,
      packId: run.packId,
      packVersion: run.packVersion,
      claimToken: token,
      leaseSeconds: leaseSeconds(),
    };
  }

  async heartbeat(p: {
    companyId: string;
    runId: string;
    claimToken: string;
  }): Promise<HeartbeatWorkResponse> {
    const renewed = await this.surreal.withCompany(p.companyId, async (db) => {
      const rows = await queryRows<unknown>(
        db,
        `UPDATE type::record('indexer_run', $run) SET createdAt = time::now()
         WHERE external = true AND status = 'running' AND claimToken = $tok
         RETURN AFTER`,
        { run: idTailOf(p.runId), tok: p.claimToken },
      );
      return rows[0] ?? null;
    });
    if (!renewed) {
      throw new ConflictException('claim lost: token mismatch or run not running');
    }
    return { runId: p.runId, leaseSeconds: leaseSeconds() };
  }

  async content(p: {
    companyId: string;
    runId: string;
    keyPackIds?: string[];
  }): Promise<WorkContentResponse> {
    const run = await this.getExternalRun(p.companyId, p.runId);
    if (run.status !== 'pending' && run.status !== 'running') {
      throw new ConflictException(
        `work item is ${run.status} — content is served for pending/claimed work only`,
      );
    }
    assertKeyBoundToPack(p.keyPackIds, run.packId);
    this.assertExternalPack(
      await this.externalPackIds(p.companyId),
      run.packId,
    );
    const doc = await this.store.getById(p.companyId, run.docId);
    if (!doc) throw new NotFoundException('document not found');
    if (!doc.hasContent) {
      throw new NotFoundException(
        'document has no stored content (storeContent=false) — extract from your own copy and submit; spans will stage ungrounded',
      );
    }
    const chunks = await this.store.getChunks(p.companyId, run.docId);
    return {
      documentId: doc.id,
      kind: doc.kind,
      vertical: doc.vertical,
      occurredAt: doc.occurredAt.toISOString(),
      chunkCount: doc.chunkCount,
      chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
    };
  }

  async fail(p: {
    companyId: string;
    runId: string;
    claimToken: string;
    error?: string;
    permanent?: boolean;
  }): Promise<FailWorkResponse> {
    // Default RELEASE: back to 'pending' so the next poll rediscovers the
    // work (beats squatting on the claim until the lease expires).
    // permanent=true marks it 'failed' — "cannot process this document":
    // no longer offered, still directly claimable by runId for a retry.
    const set = p.permanent
      ? `status = 'failed', finishedAt = time::now(), error = { message: $msg }`
      : `status = 'pending', claimToken = NONE, claimedAt = NONE,
         createdAt = time::now(), error = { message: $msg }`;
    const updated = await this.surreal.withCompany(p.companyId, async (db) => {
      const rows = await queryRows<unknown>(
        db,
        `UPDATE type::record('indexer_run', $run) SET ${set}
         WHERE external = true AND status = 'running' AND claimToken = $tok
         RETURN AFTER`,
        {
          run: idTailOf(p.runId),
          tok: p.claimToken,
          msg: p.error?.slice(0, 500) ?? 'released_by_indexer',
        },
      );
      return rows[0] ?? null;
    });
    if (!updated) {
      throw new ConflictException('claim lost: token mismatch or run not running');
    }
    return { runId: p.runId, status: p.permanent ? 'failed' : 'released' };
  }

  /**
   * Verify a claimed run before an authenticated submission uses it:
   * right document, right pack, live claim, matching token. Called by
   * ExternalCandidatesService when the DTO carries runId + claimToken.
   */
  async verifyClaimForSubmit(p: {
    companyId: string;
    runId: string;
    claimToken: string;
    docId: string;
    packId: string;
  }): Promise<RunRow> {
    const run = await this.getExternalRun(p.companyId, p.runId);
    if (idTailOf(run.docId) !== idTailOf(p.docId)) {
      throw new ConflictException('claimed run belongs to a different document');
    }
    if (run.packId !== p.packId) {
      throw new ConflictException('claimed run belongs to a different pack');
    }
    if (run.status !== 'running' || run.claimToken !== p.claimToken) {
      throw new ConflictException('claim lost: token mismatch or run not running');
    }
    return run;
  }

  private async getExternalRun(
    companyId: string,
    runId: string,
  ): Promise<RunRow> {
    const run = await this.candidates.getRun(companyId, runId);
    // A non-external run is invisible on this surface — same 404 as a
    // missing one, so the endpoint doesn't oracle the internal ledger.
    if (!run || !run.external) {
      throw new NotFoundException('work item not found');
    }
    return run;
  }

  private async externalPackIds(companyId: string): Promise<Set<string>> {
    const bindings = await this.router.bindingsFor(companyId);
    return new Set(
      bindings.filter((b) => b.mode === 'external').map((b) => b.indexerId),
    );
  }

  private assertExternalPack(externalPacks: Set<string>, packId: string): void {
    if (!externalPacks.has(packId)) {
      throw new NotFoundException(
        `indexer pack "${packId}" is not installed for this tenant`,
      );
    }
  }
}

/** Intersect the tenant's external packs with a key's binding (0 = all). */
function boundPacks(
  externalPacks: Set<string>,
  keyPackIds?: string[],
): Set<string> {
  if (!keyPackIds || keyPackIds.length === 0) return externalPacks;
  return new Set([...externalPacks].filter((id) => keyPackIds.includes(id)));
}

/**
 * A pack-bound key acting outside its binding is a permission error, not
 * invisibility — the packs of one's own tenant are not a secret, and a
 * clear 403 beats operators chasing phantom 404s.
 */
export function assertKeyBoundToPack(
  keyPackIds: string[] | undefined,
  packId: string,
): void {
  if (keyPackIds && keyPackIds.length > 0 && !keyPackIds.includes(packId)) {
    throw new ForbiddenException(
      `this key is not bound to indexer pack "${packId}"`,
    );
  }
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit) || (limit as number) <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(limit as number), MAX_LIST_LIMIT);
}

function leaseSeconds(): number {
  return Math.floor(staleRunMs() / 1000);
}

function toIso(v: unknown): string {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
