import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../../db/surreal.service';
import { EmbedderService } from '../embedder.service';
import { envFlagEnabled } from '../../common/env-validation';

/**
 * EmbeddingSpaceService — the per-tenant zero-downtime migration protocol
 * (multilingual Tier 2, migration 0101).
 *
 * A tenant's rows live in ONE embedding space at query time — never mixed.
 * Moving a tenant from space A → space B without downtime is a three-phase
 * choreography, each phase gated OFF by default:
 *
 *   1. begin  (EMBEDDING_SPACE_DUAL_WRITE) — arm shadow dual-write: new
 *      writes are produced in BOTH the active space and the target space so
 *      the target is kept warm while the reindex backfills history.
 *   2. reindex — POST /v1/admin/reindex/embeddings?allTables=true rewrites
 *      every historical vector into the target space (stamping
 *      embeddingSpaceId under EMBEDDING_SPACE_TRACKING).
 *   3. cutover (EMBEDDING_SPACE_ACTIVE) — an ATOMIC single-statement flip of
 *      the tenant's active space to the target, after the reindex completes.
 *      Reads switch wholly to the target space; there is never a window where
 *      a query is compared against a half-migrated corpus.
 *
 * State lives in a singleton row `embedding_space_state:current` per tenant
 * DB. Absent / unset ⇒ the tenant is wholly in the CURRENT provider space
 * (the legacy/implicit space) — so with every flag off, `activeSpaceFor`
 * returns the provider's own space and serving is byte-identical to
 * pre-Tier-2.
 *
 * SCOPE NOTE (honest bound): the atomic per-tenant state machine + resolver
 * are fully built and tested here. Wiring the shadow dual-write into every
 * live ingest/derive write site, and the active-space WHERE filter into
 * every search leg, is the remaining mechanical surface — it reuses
 * `activeSpaceFor` / `targetSpaceFor` exactly as the reindex sweep reuses
 * `EmbedderService.activeSpaceId()`. That per-site wiring is deferred (it
 * touches many hot paths) and called out in the Tier-2 report.
 */

export type MigrationPhase = 'idle' | 'dual_write' | 'cut_over';

export interface EmbeddingSpaceState {
  /** The space reads select for this tenant. */
  activeSpace: string;
  /** The space an in-flight migration is moving into (null ⇒ none). */
  targetSpace: string | null;
  /** True while shadow dual-write is arming the target space. */
  dualWrite: boolean;
  phase: MigrationPhase;
}

interface StateRow {
  activeSpace?: string | null;
  targetSpace?: string | null;
  dualWrite?: boolean | null;
  phase?: MigrationPhase | null;
}

const STATE_ID = 'embedding_space_state:current';

@Injectable()
export class EmbeddingSpaceService {
  private readonly logger = new Logger(EmbeddingSpaceService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    private readonly config: ConfigService,
  ) {}

  /** Master switch for active-space selection + cutover. */
  private activeEnabled(): boolean {
    return envFlagEnabled(this.config.get<string>('EMBEDDING_SPACE_ACTIVE'));
  }

  /** Switch for arming shadow dual-write. */
  private dualWriteEnabled(): boolean {
    return envFlagEnabled(this.config.get<string>('EMBEDDING_SPACE_DUAL_WRITE'));
  }

  /**
   * The space id the READ path should use for this tenant. When
   * EMBEDDING_SPACE_ACTIVE is off, or no migration state exists, this is the
   * current provider's space — byte-identical to pre-Tier-2 serving. A
   * tenant is WHOLLY in this one space at query time.
   */
  async activeSpaceFor(companyId: string): Promise<string> {
    const fallback = this.embedder.primarySpaceId();
    if (!this.activeEnabled()) return fallback;
    const state = await this.readState(companyId);
    return state?.activeSpace ?? fallback;
  }

  /**
   * The dual-write TARGET space for this tenant, or null when no migration
   * is arming. Null whenever EMBEDDING_SPACE_DUAL_WRITE is off — so the
   * dual-write write sites are inert by default.
   */
  async targetSpaceFor(companyId: string): Promise<string | null> {
    if (!this.dualWriteEnabled()) return null;
    const state = await this.readState(companyId);
    return state?.dualWrite ? (state.targetSpace ?? null) : null;
  }

  /** The full state, defaulted for reporting. */
  async getState(companyId: string): Promise<EmbeddingSpaceState> {
    const fallback = this.embedder.primarySpaceId();
    const row = await this.readState(companyId);
    return {
      activeSpace: row?.activeSpace ?? fallback,
      targetSpace: row?.targetSpace ?? null,
      dualWrite: row?.dualWrite ?? false,
      phase: row?.phase ?? 'idle',
    };
  }

  /**
   * Phase 1 — arm shadow dual-write into `targetSpace`. Gated by
   * EMBEDDING_SPACE_DUAL_WRITE. Idempotent. The active space is left
   * untouched (reads keep serving the old space) — only new writes gain a
   * second, target-space vector once the dual-write write sites consult
   * `targetSpaceFor`.
   */
  async beginMigration(companyId: string, targetSpace: string): Promise<EmbeddingSpaceState> {
    if (!this.dualWriteEnabled()) {
      throw new BadRequestException(
        'EMBEDDING_SPACE_DUAL_WRITE is off — cannot begin a space migration',
      );
    }
    this.assertSpaceId(targetSpace);
    const active = await this.activeSpaceFor(companyId);
    if (targetSpace === active) {
      throw new BadRequestException(
        `target space '${targetSpace}' equals the active space — nothing to migrate`,
      );
    }
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(
        `UPSERT ${STATE_ID} SET
           activeSpace = $active, targetSpace = $target,
           dualWrite = true, phase = 'dual_write', updatedAt = time::now()`,
        { active, target: targetSpace },
      );
    });
    this.logger.log(`[embedding-space] begin migration ${companyId}: ${active} -> ${targetSpace}`);
    return this.getState(companyId);
  }

  /**
   * Phase 3 — ATOMIC per-tenant cutover. Flips the active space to the
   * target in a SINGLE UPSERT statement (all-or-nothing) and clears the
   * dual-write arming. Gated by EMBEDDING_SPACE_ACTIVE. Refuses unless a
   * migration into `targetSpace` is in flight, so a cutover can only follow
   * a begin (+ the operator's reindex). After this, reads serve the target
   * space wholly.
   */
  async cutover(companyId: string, targetSpace: string): Promise<EmbeddingSpaceState> {
    if (!this.activeEnabled()) {
      throw new BadRequestException(
        'EMBEDDING_SPACE_ACTIVE is off — per-tenant active-space cutover is disabled',
      );
    }
    this.assertSpaceId(targetSpace);
    const state = await this.getState(companyId);
    if (state.targetSpace !== targetSpace) {
      throw new BadRequestException(
        `no migration into '${targetSpace}' is in flight for ${companyId} ` +
          `(current target: ${state.targetSpace ?? 'none'}). Begin a migration and ` +
          `reindex before cutting over.`,
      );
    }
    await this.surreal.withCompany(companyId, async (db) => {
      // Single statement ⇒ atomic: no window where activeSpace is set but
      // targetSpace/dualWrite are stale.
      await db.query(
        `UPSERT ${STATE_ID} SET
           activeSpace = $target, targetSpace = NONE,
           dualWrite = false, phase = 'cut_over', updatedAt = time::now()`,
        { target: targetSpace },
      );
    });
    this.logger.log(`[embedding-space] cutover ${companyId} -> ${targetSpace}`);
    return this.getState(companyId);
  }

  /**
   * Abort an in-flight migration — clears the target + dual-write arming,
   * leaving the active space untouched. Gated by EMBEDDING_SPACE_ACTIVE
   * (same surface as cutover). Idempotent.
   */
  async abortMigration(companyId: string): Promise<EmbeddingSpaceState> {
    if (!this.activeEnabled()) {
      throw new BadRequestException('EMBEDDING_SPACE_ACTIVE is off — nothing to abort');
    }
    await this.surreal.withCompany(companyId, async (db) => {
      await db.query(
        `UPSERT ${STATE_ID} SET
           targetSpace = NONE, dualWrite = false, phase = 'idle', updatedAt = time::now()`,
      );
    });
    this.logger.log(`[embedding-space] abort migration ${companyId}`);
    return this.getState(companyId);
  }

  private async readState(companyId: string): Promise<StateRow | null> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const [rows] = await db.query<[StateRow[]]>(
          `SELECT activeSpace, targetSpace, dualWrite, phase FROM ${STATE_ID}`,
        );
        return (rows as StateRow[])?.[0] ?? null;
      });
    } catch (e) {
      // A missing table / fresh tenant reads as "no state" ⇒ current space.
      this.logger.warn(
        `[embedding-space] state read failed for ${companyId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private assertSpaceId(id: string): void {
    if (typeof id !== 'string' || id.trim().length < 3) {
      throw new BadRequestException(`invalid embedding space id: '${id}'`);
    }
  }
}
