import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { mediaPiiGate } from '../common/media-pii';
import { capabilityForModality } from '../common/evidence-taxonomy';
import { hasCurrentModalityConsent, type ModalityConsentRow } from '../ai/domain-packs';
import { rrfFuse } from './segment-lane.service';
import type { CitableFragment } from './fragment-citations';

/** Fragment lines per prompt (design constant, MM-zoom PR2 —
 *  deliberately NOT an env knob until the lane is measured). */
const FRAGMENT_LANE_TOP_K = 4;
/** Rendered excerpt cap per line (the 600-char line-cap idiom). */
const FRAGMENT_EXCERPT_MAX_CHARS = 600;

/** derived_representation row + the joined fragment/asset columns. */
interface FragmentReprRow {
  id: unknown;
  content?: unknown;
  kind?: unknown;
  fragmentId?: unknown;
  assetId?: unknown;
  modality?: unknown;
  occurredAt?: Date | string;
  score?: number;
}

/** The lane's output: rendered lines + the rendered-set citation fence. */
export interface FragmentLaneResult {
  /** One line per fragment, chronological, `[capability:<kind>]`-tagged
   *  (the VerifyRequest.capabilityEvidenceLines contract). */
  lines: string[];
  /**
   * fragmentId → rendered-fragment info for resolveFragmentCitations —
   * EXACTLY the fragments rendered into `lines` (the l3-citations
   * turnsById fence). Empty when `withIds` was false (citations flag
   * off: no headers rendered, nothing citable).
   */
  byId: Map<string, CitableFragment>;
}

const EMPTY_RESULT: FragmentLaneResult = { lines: [], byId: new Map() };

/**
 * Fragment retrieval lane (MM-zoom PR2, profile.fragmentLane /
 * RETRIEVAL_FRAGMENT_LANE) — the Evidence Plane's first serving surface.
 *
 * Retrieves derived_representation rows (captions / OCR / ASR / text
 * renders of 0109 media observations) on their own dense+BM25 merit —
 * the segment-lane shape: two legs fused by reciprocal rank — and
 * renders them as a media-evidence prompt section. The dense leg is a
 * brute cosine over derived_representation.embedding, which is
 * WRITE-DEAD in v1 (no producer fills it — 0109 header), so it degrades
 * to empty by construction until a producer exists; the lexical leg
 * rides the 0124 lowercase FULLTEXT index.
 *
 * FENCE ORDER (the PR2 design contract, composed per read):
 *   1. tenant          — SurrealService.withCompany scoping;
 *   2. asset-join user fence — fragment→asset ownership: an unscoped
 *      read serves tenant-global assets only; a scoped read adds the
 *      caller's own. Assets are SINGLE-OWNER rows (0109 userId, no
 *      member set), so the 0055 gate applies and the 0117 per-member
 *      variant (segmentUserGate — built for multi-user windows) has
 *      nothing extra to close here;
 *   3. media PII       — mediaPiiGate on the FRAGMENT's piiClasses,
 *      fail-closed: unclassified (NONE) rows are blocked; only the
 *      affirmatively-clean [] or brain:read_media opens a row;
 *   4. 0112 modality consent — tenant-level: consent absent or stale
 *      (hasCurrentModalityConsent) ⇒ the lane is EMPTY. Checked before
 *      the row read as an optimization (it is a lane-level AND — early
 *      execution cannot change the result, only skip wasted work);
 *   5. availability    — 'gone' tombstones (bytes erased) never serve;
 *   6. any error degrades to an empty section, never fails the answer.
 *
 * Same contracts as the sibling lanes: activation comes from the
 * resolved RetrievalProfile via the caller; the citation-header switch
 * (`withIds` — EVIDENCE_FRAGMENT_CITATIONS) arrives resolved from the
 * caller too, so this service reads no env.
 */
@Injectable()
export class FragmentLaneService {
  private readonly logger = new Logger(FragmentLaneService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async fragmentLines(opts: {
    companyId: string;
    query: string;
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
    /** Render `[evidence_fragment:...]` headers + populate the citation
     *  fence map (EVIDENCE_FRAGMENT_CITATIONS, resolved by the caller). */
    withIds: boolean;
  }): Promise<FragmentLaneResult> {
    const fetchK = Math.max(FRAGMENT_LANE_TOP_K * 3, 12);
    // Fence 3: the fragment's own piiClasses, through the record link.
    const piiGate = mediaPiiGate(opts.callerScopes, 'subjectId.piiClasses');
    // Fence 2: asset-join user fence (single-owner 0055 gate — see class doc).
    const userFence =
      opts.userId === undefined
        ? { clause: 'AND subjectId.assetId.userId IS NONE', params: {} }
        : {
            clause:
              'AND (subjectId.assetId.userId IS NONE OR subjectId.assetId.userId = $scopeUserId)',
            params: { scopeUserId: opts.userId },
          };
    try {
      // Fence 4 (0112): tenant-level consent — absent/stale ⇒ EMPTY.
      const consented = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [rows] = await db.query<[ModalityConsentRow[]]>(
          `SELECT manifest, acceptedModalities, acceptedModalitiesChecksum FROM domain_pack`,
        );
        return hasCurrentModalityConsent(rows ?? []);
      });
      if (!consented) return EMPTY_RESULT;

      // Dense leg's query vector — its own degrade: an embedder failure
      // must not kill the lexical leg.
      let queryVector: number[] | null = null;
      try {
        queryVector = await this.embedder.embed(opts.query);
      } catch (e) {
        this.logger.warn(`fragment lane dense leg unavailable: ${(e as Error).message}`);
      }

      // Fences 1/2/3/5 compose in the WHERE, in the design order.
      const where = `subjectKind = 'fragment'
            ${userFence.clause}
            ${piiGate}
            AND subjectId.assetId.availability != 'gone'`;
      const select = `id, content, kind,
                subjectId AS fragmentId,
                subjectId.assetId AS assetId,
                subjectId.assetId.modality AS modality,
                subjectId.assetId.occurredAt AS occurredAt`;
      const fused = await this.surreal.withCompany(opts.companyId, async (db) => {
        const [dense] = queryVector
          ? await db.query<[FragmentReprRow[]]>(
              `SELECT ${select},
                    vector::similarity::cosine(embedding, $q) AS score
               FROM derived_representation
              WHERE embedding != NONE AND ${where}
              ORDER BY score DESC
              LIMIT $k`,
              { q: queryVector, k: fetchK, ...userFence.params },
            )
          : [[] as FragmentReprRow[]];
        const [bm25] = await db.query<[FragmentReprRow[]]>(
          `SELECT ${select}, search::score(1) AS score
               FROM derived_representation
              WHERE content @1@ $q AND ${where}
              ORDER BY score DESC
              LIMIT $k`,
          { q: opts.query, k: fetchK, ...userFence.params },
        );
        return rrfFuse([dense ?? [], bm25 ?? []]);
      });
      if (fused.length === 0) return EMPTY_RESULT;
      return this.render(fused, opts.withIds);
    } catch (e) {
      // Fence 6: degrade to an empty section, never fail the answer.
      this.logger.warn(
        `fragment lane failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return EMPTY_RESULT;
    }
  }

  /**
   * One line per FRAGMENT (a fragment with several representations —
   * caption + OCR — keeps its best-fused row), chronological, capped at
   * FRAGMENT_LANE_TOP_K. Line shape:
   *   `[capability:<kind>] [<fragmentId>] (<modality> <reprKind>, <day>) <excerpt>`
   * with the `[<fragmentId>]` header only under `withIds` (the L3
   * episode-header idiom — flag off renders byte-identical lines with
   * no citable surface). The capability tag leads every line — the
   * VerifyRequest.capabilityEvidenceLines contract.
   */
  private render(fused: FragmentReprRow[], withIds: boolean): FragmentLaneResult {
    const byFragment = new Map<string, FragmentReprRow>();
    for (const row of fused) {
      const fragmentId = row.fragmentId === undefined ? '' : String(row.fragmentId);
      const content = typeof row.content === 'string' ? row.content : '';
      if (!fragmentId || !content.trim()) continue;
      if (!byFragment.has(fragmentId)) byFragment.set(fragmentId, row);
      if (byFragment.size >= FRAGMENT_LANE_TOP_K) break;
    }
    const kept = [...byFragment.entries()].sort(
      ([, a], [, b]) => toMs(a.occurredAt) - toMs(b.occurredAt),
    );
    const lines: string[] = [];
    const byId = new Map<string, CitableFragment>();
    for (const [fragmentId, row] of kept) {
      const modality = String(row.modality ?? 'unknown');
      const capability = capabilityForModality(modality);
      const excerpt = String(row.content).slice(0, FRAGMENT_EXCERPT_MAX_CHARS);
      const day = isoDay(row.occurredAt);
      const base =
        `[capability:${capability}] ` +
        (withIds ? `[${fragmentId}] ` : '') +
        `(${modality} ${String(row.kind ?? 'text')}${day ? `, ${day}` : ''}) ${excerpt}`;
      lines.push(base);
      if (withIds) {
        byId.set(fragmentId, {
          fragmentId,
          assetId: String(row.assetId ?? ''),
          capability,
          excerpt,
          ...(day ? { occurredAt: isoInstant(row.occurredAt) } : {}),
        });
      }
    }
    return { lines, byId };
  }
}

function toMs(v: Date | string | undefined): number {
  if (v === undefined) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

function isoDay(v: Date | string | undefined): string {
  if (v === undefined) return '';
  const ms = toMs(v);
  return ms === 0 ? '' : new Date(ms).toISOString().slice(0, 10);
}

function isoInstant(v: Date | string | undefined): string {
  return new Date(toMs(v)).toISOString();
}
