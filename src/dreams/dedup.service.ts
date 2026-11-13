import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal, StringRecordId } from 'surrealdb';
import { EntityJudgeService, type JudgeContext } from '../ai/entity-judge.service';
import { withSpan } from '../common/tracing';
import { envFlagNotDisabled } from '../common/env-validation';
import { sameWidthGate } from '../db/vector-width';
import { EntityCandidateService, judgeSimilarity } from '../ingest/entity-candidates.service';
import { alreadyJudged, loadPairMemo, pairSignature, recordPairVerdict } from './pair-memo';
import { recordKey } from '../db/record-key';

/** The index the entity-dedup seed KNN rides — for the diagnostic. */

/**
 * DreamsDedupService — find near-duplicate ENTITIES inside a tenant
 * and emit identity_of links so survivor + loser collapse into one
 * search-side record.
 *
 * Two-stage filter:
 *   1. CHEAP: vector similarity over the entity's OWN name embedding
 *      (knowledge_entity.embedding — a column the 0001 baseline defined and nothing ever wrote). For each seed entity,
 *      fetch the K nearest same-type neighbours by cosine; consider any
 *      pair with cos ≥ threshold a SUSPECT.
 *   2. EXPENSIVE: LLM judge with both entities' top-3 facts as context.
 *      Verdict ∈ {same, different, unsure}. Only `same` triggers a
 *      RELATE knowledge_edge (kind='identity_of'); `unsure` is logged
 *      for operator review.
 *
 * Bounded per run by DREAMS_DEDUP_MAX_PAIRS so a single tenant can't
 * monopolise the off-hours budget. Skip pairs that already have an
 * identity_of edge (idempotent re-runs).
 *
 * Failure modes are explicit. LLM outage → mark suspect, log,
 * continue. Surreal outage → bubble up to the orchestrator which
 * tags the run outcome=hop_error and stops the chain.
 */
export interface DedupCandidate {
  aId: string;
  bId: string;
  /** Similarity on the finding scan's own scale (`similarity` names it). */
  cosine: number;
  /** Which scan proposed the pair — the judge's prompt says what it means. */
  similarity?: NonNullable<JudgeContext['similarity']>;
  /** The two canonical names, for the judge (a cross-script pair is the same name). */
  names?: { a?: string | undefined; b?: string | undefined };
}

export interface DedupIdentityLink {
  survivorId: string;
  loserId: string;
  cosine: number;
}

export interface DedupResult {
  suspectsEvaluated: number;
  llmJudgements: number;
  identityLinksCreated: number;
  unsurePairs: number;
  /** Per-link detail for the admin UI drill-down. Empty when dedup didn't run. */
  identityLinks: DedupIdentityLink[];
  /** Pairs skipped: the judge already answered this evidence (0173). */
  memoSkipped?: number;
}

/** Candidates gathered per judged pair, so memoized pairs do not starve the rest. */
const CANDIDATE_OVERFETCH = 4;

@Injectable()
export class DreamsDedupService {
  private readonly logger = new Logger(DreamsDedupService.name);
  private readonly enabled: boolean;
  private readonly cosineThreshold: number;
  private readonly maxPairs: number;
  private readonly maxSeeds: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly judge: EntityJudgeService,
    private readonly candidates: EntityCandidateService,
  ) {
    this.enabled = envFlagNotDisabled(this.configService.get<string>('DREAMS_DEDUP_ENABLED'));
    this.cosineThreshold = parseFloat(
      this.configService.get<string>('DREAMS_DEDUP_COSINE_THRESHOLD', '0.92'),
    );
    this.maxPairs = parseInt(this.configService.get<string>('DREAMS_DEDUP_MAX_PAIRS', '50'), 10);
    // Bounds the neighbour-query loop (one query per seed). maxPairs
    // only capped EMITTED pairs — on a corpus where few pairs cleared
    // the threshold, the loop still ran one full scan per entity:
    // O(N²) vector ops per tenant per night. Newest name facts seed
    // first, so recently-touched entities are always covered.
    this.maxSeeds = parseInt(this.configService.get<string>('DREAMS_DEDUP_MAX_SEEDS', '500'), 10);
  }

  isEnabled(): boolean {
    return this.enabled && this.judge.isAvailable();
  }

  /** Configured on, whoever judges (the harness work reads this). */
  configured(): boolean {
    return this.enabled;
  }

  /**
   * Run dedup for ONE tenant. The caller (DreamsService) owns the
   * Surreal connection and tenant scoping — we just operate over the
   * passed `db` handle. This keeps the service stateless and
   * compatible with the controller's per-request manual trigger.
   */
  async run(db: Surreal, derivedVersion: string | null = null): Promise<DedupResult> {
    const result: DedupResult = {
      suspectsEvaluated: 0,
      llmJudgements: 0,
      identityLinksCreated: 0,
      unsurePairs: 0,
      identityLinks: [],
    };
    if (!this.isEnabled()) return result;

    const candidates = await withSpan(
      'dreams.dedup.find_candidates',
      () => this.findCandidates(db, derivedVersion),
      { 'dedup.cosine_threshold': this.cosineThreshold },
    );
    result.suspectsEvaluated = candidates.length;
    if (candidates.length === 0) return result;

    // A pair judged `different`/`unsure` on the same evidence is not paid
    // for again (0173); the candidate list is over-fetched so memoized
    // pairs no longer hold the night's slots.
    const memo = await loadPairMemo(db, 'dedup');
    for (const cand of candidates) {
      if (result.llmJudgements >= this.maxPairs) break;
      // Skip pairs that already have an identity_of edge — idempotent.
      const exists = await this.identityEdgeExists(db, cand.aId, cand.bId);
      if (exists) continue;

      const factsA = await this.judge.fetchTopFacts(db, cand.aId);
      const factsB = await this.judge.fetchTopFacts(db, cand.bId);
      const pairKey = `${cand.aId}|${cand.bId}`;
      const signature = pairSignature(factsA, factsB);
      if (alreadyJudged(memo, { pairKey, signature })) {
        result.memoSkipped = (result.memoSkipped ?? 0) + 1;
        continue;
      }
      const verdict = await withSpan('dreams.dedup.judge', () =>
        this.judge.judge(factsA, factsB, {
          cosine: cand.cosine,
          offline: true,
          ...(cand.similarity ? { similarity: cand.similarity } : {}),
          ...(cand.names ? { names: cand.names } : {}),
        }),
      );
      result.llmJudgements++;
      if (verdict !== 'same') {
        await recordPairVerdict(db, { kind: 'dedup', pairKey, signature, verdict });
      }
      if (verdict === 'same') {
        await this.linkIdentity(db, cand.aId, cand.bId);
        result.identityLinksCreated++;
        result.identityLinks.push({
          survivorId: cand.aId,
          loserId: cand.bId,
          cosine: cand.cosine,
        });
      } else if (verdict === 'unsure') {
        result.unsurePairs++;
        this.logger.warn(
          `[dreams.dedup] unsure pair: ${cand.aId} ⟷ ${cand.bId} (cos=${cand.cosine.toFixed(3)})`,
        );
      }
    }
    return result;
  }

  /**
   * Find suspect pairs: for each entity carrying a name embedding, its
   * nearest same-type neighbours by cosine, kept when cos ≥ threshold and
   * ordered aId < bId so each pair is counted once. Capped at maxPairs to
   * bound the LLM cost.
   *
   * OVER ENTITIES, NOT `name` FACTS. This pass used to
   * seed from `knowledge_fact WHERE predicate = 'name'` and walk that
   * fact's embedding, and measured on a live tenant on 2026-09-16 that
   * predicate had ZERO rows against 33 entities: nothing on the mention
   * path writes a `name` fact. Every off-hours dedup sweep on a
   * mention-ingested corpus had found zero seeds, logged nothing, and
   * merged nothing — not "rarely", structurally.
   *
   * Entities are one to two orders of magnitude fewer than facts, so the
   * seed set and each neighbour query are plain cosine scans; the HNSW
   * leg that rode `fact_embedding_hnsw` went with the fact scan. The
   * embedding still never leaves the DB — each neighbour query reads the
   * seed vector by entity id.
   *
   * `derivedVersion` is accepted for the caller's contract and not used
   * to fence candidates: it is a FACT field (0074), an entity is the same
   * node in every derived world, and the judge's evidence
   * (`fetchTopFacts`) was never world-fenced either.
   */
  async findCandidates(db: Surreal, _derivedVersion: string | null): Promise<DedupCandidate[]> {
    type SeedRow = {
      id: unknown;
      type: string;
      canonicalName?: string;
      hasVector?: boolean;
      recordedAt: unknown;
    };
    const [seedRows] = await db.query<[SeedRow[]]>(
      `SELECT id, type, canonicalName, embedding != NONE AS hasVector, recordedAt
         FROM knowledge_entity
       WHERE (embedding != NONE OR nameKeys != NONE)
         AND userId IS NONE
         AND mergedInto IS NONE
       ORDER BY recordedAt DESC
       LIMIT $maxSeeds`,
      { maxSeeds: this.maxSeeds },
    );
    const seeds = (seedRows as SeedRow[]) ?? [];
    if (seeds.length < 2) return [];

    const out: DedupCandidate[] = [];
    const seen = new Set<string>();
    const cap = this.maxPairs * CANDIDATE_OVERFETCH;
    const push = (seed: SeedRow, c: Omit<DedupCandidate, 'aId' | 'bId'> & { id: string }) => {
      const aId = String(seed.id);
      const bId = c.id;
      if (bId === aId) return;
      const pairKey = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (seen.has(pairKey)) return;
      seen.add(pairKey);
      const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
      const [na, nb] =
        aId < bId ? [seed.canonicalName, c.names?.b] : [c.names?.b, seed.canonicalName];
      out.push({
        aId: a,
        bId: b,
        cosine: c.cosine,
        ...(c.similarity ? { similarity: c.similarity } : {}),
        names: { a: na, b: nb },
      });
    };
    for (const seed of seeds) {
      const aId = String(seed.id);
      // The NAME first: the same blocking the inline resolver runs
      // (entity-candidates.service.ts) — a transliteration, a first name,
      // initials, a surname no one else carries. This pass used to see
      // only pairs whose name embeddings cleared 0.92, and a name
      // embedding is the signal measured unable to separate "Ivan Petrov"
      // from "Иван Сидоров" (common/name-key.ts); a keyless or harness
      // install, which judges nothing at ingest, depends on this pass for
      // every link the deterministic rungs did not make.
      if (seed.canonicalName) {
        const q = { name: seed.canonicalName, type: seed.type, excludeId: aId };
        for (const scan of this.candidates.nameScans(db, q)) {
          for (const c of await scan()) {
            push(seed, {
              id: c.entityId,
              cosine: c.cosine,
              similarity: judgeSimilarity(c.matchKind),
              names: { b: c.canonicalName },
            });
          }
        }
      }
      if (seed.hasVector !== false) {
        for (const n of await this.nearestNames(db, aId, seed.type)) {
          if (n.sim < this.cosineThreshold) continue;
          push(seed, {
            id: String(n.entityId),
            cosine: n.sim,
            similarity: 'embedding',
            names: { b: n.canonicalName },
          });
        }
      }
      if (out.length >= cap) return out.slice(0, cap);
    }
    return out;
  }

  /**
   * K nearest entities of the same type to a seed entity, by cosine over
   * their name embeddings; the seed vector is resolved DB-side by id so
   * no vector is shipped to JS in either direction.
   */
  private async nearestNames(
    db: Surreal,
    seedEntityId: string,
    type: string,
  ): Promise<Array<{ entityId: unknown; canonicalName?: string; sim: number }>> {
    type Row = { entityId: unknown; canonicalName?: string; sim: number };
    const res = await db.query<[unknown, Row[]]>(
      `LET $q = (SELECT VALUE embedding FROM ONLY type::record('knowledge_entity', $eid));
       SELECT id AS entityId, canonicalName, vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_entity
        WHERE ${sameWidthGate('embedding')}
          AND type = $type
          AND userId IS NONE
          AND mergedInto IS NONE
          AND id != type::record('knowledge_entity', $eid)
        ORDER BY sim DESC
        LIMIT 5;`,
      { eid: recordKey(seedEntityId), type },
    );
    return (res[1] as Row[]) ?? [];
  }

  async identityEdgeExists(db: Surreal, aId: string, bId: string): Promise<boolean> {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM knowledge_edge
       WHERE kind = 'identity_of'
         AND ((in = $a AND out = $b) OR (in = $b AND out = $a))
       LIMIT 1`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
    return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
  }

  async linkIdentity(db: Surreal, aId: string, bId: string): Promise<void> {
    // Direction: aId → bId. The conventional survivor/loser policy
    // (older entity wins) is enforced by the existing identity-merge
    // path in the search service via mergedInto reattribution; from
    // dreams we just emit the link with weight 1.0 and source tag. The
    // identity holds from when it was found (0164: a relation that names
    // no day holds from when it was said); without validFrom the edge read
    // as "start unknown" (data migration edge_valid_from_created).
    await db.query(
      `RELATE $a->knowledge_edge->$b SET kind = 'identity_of', weight = 1.0,
        source = { vertical: 'dreams', kind: 'auto_dedup' },
        createdAt = time::now(), validFrom = time::now()`,
      {
        a: new StringRecordId(aId),
        b: new StringRecordId(bId),
      },
    );
  }
}
