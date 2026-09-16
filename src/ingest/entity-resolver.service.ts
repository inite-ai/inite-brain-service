import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { EntityJudgeService, EntityVerdict } from '../ai/entity-judge.service';
import { traceArtifact } from '../common/debug-trace';
import { envFlagEnabled } from '../common/env-validation';
import { nameKey } from '../common/name-key';
import { dbCreate } from '../db/surreal.service';

/** One auditable reuse/candidate decision (migration 0102 entity_merge_log). */
export interface MergeLogEntry {
  mention: string;
  type: string;
  targetEntity: string;
  verdict: EntityVerdict;
  cosine: number;
  matchKind: 'exact' | 'externalRef' | 'translit' | 'embedding' | 'article-variant';
  decision: 'reused' | 'candidate';
}

/**
 * EntityResolverService — inline entity resolution at ingest time
 * (graphiti-style). Before the mention pipeline mints a NEW entity for an
 * extracted name that missed the exact canonicalName match, we look for a
 * near-duplicate that already exists and, when the shared EntityJudge
 * confirms it's the same real-world thing, reuse it — so the duplicate is
 * never created.
 *
 * Why a judge and not bare cosine: two different "John Smith"s have
 * near-identical name embeddings and the same type; merging on cosine
 * alone would wrongly fuse them. The judge looks at the FACTS (dob /
 * email / employer) — the existing entity's stored facts vs the incoming
 * mention's freshly-extracted facts (already in memory, not yet written).
 *
 * Scope: the free-text mention path only. Structured `POST /v1/ingest/fact`
 * with an explicit `vertical:id` stays authoritative (externalRef).
 *
 * Gated by INGEST_INLINE_RESOLUTION_ENABLED (default off). Any failure
 * falls back to "create new" — inline resolution must never block ingest.
 *
 * Provenance (deliberate, graphiti-parity): a confirmed match REUSES the
 * existing entity rather than creating a duplicate + an `identity_of` edge
 * the way the off-hours dreams dedup does. So there is no reversible merge
 * edge to unlink — the trade-off for never materialising the duplicate.
 * Mitigations: the judge prefers "different" when unsure; each ingested
 * fact still carries its own `source`; the decision is logged; and the
 * flag is off by default (operators wanting reversible merges keep it off
 * and rely on dreams).
 */
/** A candidate for the judge, and which scan found it. */
interface NameCandidate {
  entityId: string;
  /** The stored entity's canonical name, for the judge's prompt. */
  canonicalName?: string | undefined;
  /** Similarity on the scan's own scale — see findKeyNeighbour on why. */
  cosine: number;
  matchKind: 'translit' | 'embedding';
}

export interface ResolveByNameOptions {
  db: Surreal;
  name: string;
  type: string;
  incomingFacts: string[];
}

@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);
  private readonly enabled: boolean;
  private readonly cosineFloor: number;
  private readonly candidateK: number;
  private readonly keyNeighbourCeiling: number;

  constructor(
    private readonly config: ConfigService,
    private readonly embedder: EmbedderService,
    private readonly judge: EntityJudgeService,
  ) {
    this.enabled = envFlagEnabled(this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED'));
    // A RECALL floor, not a precision one. Everything above it is handed to
    // the judge, which decides on FACTS; a candidate below it is never seen
    // by anything. 0.85 was set as though the cosine were the decision, and
    // it silenced the judge on every name written in a different script from
    // the one already stored. Measured on bge-m3 (the provider prod runs),
    // `name: <surface>` against `name: <surface>`, 2026-09-14:
    //
    //   SAME person / company            cos        DIFFERENT things      cos
    //   Ivan Petrov ~ Иван Петров       0.865       Ivan ~ Maria         0.445
    //   伊万·彼得罗夫 ~ إيفان بيتروف      0.825       Ivan ~ Thomas        0.484
    //   Ivan Petrov ~ 伊万·彼得罗夫       0.767       Ivan ~ 李伟           0.449
    //   Aarav Sharma ~ आरव शर्मा         0.748       Ivan Petrov ~
    //   Ivan Petrov ~ إيفان بيتروف       0.739         Иван Сидоров       0.712
    //   Иван Петров ~ إيفان بيتروف       0.695
    //   Orbital Dynamics ~ … GmbH       0.880
    //
    // Read it honestly: the bands OVERLAP. A different person who shares a
    // given name (0.712) scores above four of the six true pairs, so NO
    // threshold separates them and no amount of tuning will produce one.
    // That is the argument for the judge, not against it — and the argument
    // for putting this floor below the true band (0.695) rather than above
    // it. False candidates are what the judge is for; candidates it never
    // receives are decided by a number that provably cannot decide them.
    this.cosineFloor = parseFloat(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_COSINE_FLOOR', '0.65'),
    );
    this.candidateK = parseInt(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_CANDIDATES', '5'),
      10,
    );
    // How far out, in normalised edit distance over transliterated name
    // keys, a candidate is still worth a judge call. See findKeyNeighbour.
    this.keyNeighbourCeiling = parseFloat(
      this.config.get<string>('INGEST_INLINE_RESOLUTION_KEY_DISTANCE', '0.35'),
    );
    // Said once at boot, because "is it even on" was the first hour of
    // every linking investigation so far.
    this.logger.log(
      `[ingest.inline_resolution] ${this.enabled ? 'enabled' : 'disabled'}; ` +
        `judge ${this.judge.isAvailable() ? 'available' : 'unavailable'}; ` +
        `key-distance ceiling ${this.keyNeighbourCeiling}, cosine floor ${this.cosineFloor}`,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.judge.isAvailable();
  }

  /**
   * Tier 3 reversible-resolution switch (MULTILINGUAL_ENTITY_REVERSIBLE,
   * default off). Read per-call so a live flip lands without restart — the
   * config catalogue advertises it runtimeMutable, so it must never be
   * constructor-captured. Off ⇒ resolveByName is byte-identical (immediate
   * reuse, no merge log).
   */
  isReversible(): boolean {
    return envFlagEnabled(process.env.MULTILINGUAL_ENTITY_REVERSIBLE);
  }

  /**
   * Append one auditable row to entity_merge_log (migration 0102) so a reuse
   * is reversible / splittable. NEVER throws — an audit-log failure must not
   * block ingest (same posture as resolveByName). Callers gate on
   * isReversible() before invoking.
   */
  async recordMerge(db: Surreal, entry: MergeLogEntry): Promise<void> {
    try {
      await dbCreate(db, 'entity_merge_log', {
        mention: entry.mention,
        mentionType: entry.type,
        targetEntity: entry.targetEntity,
        verdict: entry.verdict,
        cosine: entry.cosine,
        matchKind: entry.matchKind,
        decision: entry.decision,
        // A weak candidate enters the review queue; a deterministic reused
        // row needs no review, so reviewState stays NONE (omitted).
        ...(entry.decision === 'candidate' ? { reviewState: 'pending' } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[ingest.merge_log] failed to record ${entry.decision} for ` +
          `"${entry.mention}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve an extracted entity to an EXISTING entity id when a confident
   * same-as match is found, otherwise null (caller creates a new entity).
   *
   * @param name   the extracted entity name (also its `name` fact object)
   * @param type   the normalized entity type (must match the candidate's)
   * @param incomingFacts  the mention's freshly-extracted facts for THIS
   *   entity, as `"predicate: object"` lines — the judge's "new" side.
   */
  async resolveByName({
    db,
    name,
    type,
    incomingFacts,
  }: ResolveByNameOptions): Promise<string | null> {
    if (!this.isEnabled()) return null;
    try {
      const candidate = await this.findBestNameCandidate(db, name, type);
      if (!candidate) {
        this.logger.debug(`[ingest.inline_resolution] no candidate for "${name}" (${type})`);
        return null;
      }

      const existingFacts = await this.judge.fetchTopFacts(db, candidate.entityId);
      const incoming =
        incomingFacts.length > 0 ? incomingFacts.map((f) => `- ${f}`).join('\n') : '(no facts)';
      // The judge gets both NAMES and is told which scan found the
      // candidate. Two spellings of one person in two scripts carry the
      // same facts in two languages, and without the names that reads as
      // no shared evidence at all — measured: "Фёдор Волков" was judged
      // different from "Fyodor Volkov" with the same employer and role.
      const verdict = await this.judge.judge(existingFacts, incoming, {
        cosine: candidate.cosine,
        similarity: candidate.matchKind === 'translit' ? 'transliteration' : 'embedding',
        names: { a: candidate.canonicalName, b: name },
      });
      // The whole question and the whole answer, on the trace: which
      // candidate, found how, what each side's evidence was, and what the
      // judge said. The span around the LLM call carries none of this.
      traceArtifact('ingest.entity.judge', {
        name,
        type,
        candidate: {
          entityId: candidate.entityId,
          canonicalName: candidate.canonicalName,
          matchKind: candidate.matchKind,
          cosine: candidate.cosine,
        },
        existingFacts,
        incoming,
        verdict,
        decision: verdict !== 'same' ? 'create' : this.isReversible() ? 'candidate' : 'reuse',
      });
      if (verdict === 'same') {
        if (this.isReversible()) {
          // Tier 3 (MULTILINGUAL_ENTITY_REVERSIBLE): an embedding-only match
          // is LOW-CONFIDENCE by construction — an exact-canonical /
          // externalRef signal would have reused UPSTREAM before we ran. Do
          // NOT auto-adopt the id: that fuse is unreversible once the caller
          // writes facts under it. Record a reviewable candidate and fall
          // through to "create new", deferring the merge to an explicit,
          // reversible review.
          await this.recordMerge(db, {
            mention: name,
            type,
            targetEntity: candidate.entityId,
            verdict,
            cosine: candidate.cosine,
            matchKind: candidate.matchKind,
            decision: 'candidate',
          });
          this.logger.log(
            `[ingest.inline_resolution] candidate (not auto-merged) ` +
              `${candidate.entityId} for "${name}" (cos=${candidate.cosine.toFixed(3)})`,
          );
          return null;
        }
        this.logger.log(
          `[ingest.inline_resolution] reused ${candidate.entityId} for "${name}" ` +
            `(cos=${candidate.cosine.toFixed(3)})`,
        );
        return candidate.entityId;
      }
      // Logged, because a silent null here is indistinguishable from "no
      // candidate" and that is the question every linking miss asks first.
      this.logger.log(
        `[ingest.inline_resolution] judge said ${verdict} for "${name}" vs ` +
          `${candidate.entityId} (${candidate.matchKind}=${candidate.cosine.toFixed(3)}) — creating new`,
      );
      return null;
    } catch (err) {
      // Never block ingest — fall back to "create new".
      this.logger.warn(
        `[ingest.inline_resolution] failed for "${name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The best candidate for the judge: first by transliterated-key edit
   * distance, then by cosine over the entities' own name embeddings.
   *
   * THE EMBEDDING SCAN IS OVER `knowledge_entity.embedding`,
   * NOT over `name` facts. It used to be the latter — a cosine k-NN over
   * `knowledge_fact WHERE predicate = 'name'` — and measured on a live
   * tenant on 2026-09-16 that table held ZERO such rows against 33
   * entities: nothing on the free-text mention path writes a `name`
   * fact, and the mention path is the only path this resolver serves.
   * So the scan had always searched an empty set, and with prod carrying
   * INGEST_INLINE_RESOLUTION_ENABLED=1 the "embedding + judge" step had
   * never once produced a candidate.
   *
   * Entities are one to two orders of magnitude fewer than facts, so this
   * is a plain cosine scan with no HNSW leg. The fact-table KNN variant
   * that lived here (INGEST_INLINE_RESOLUTION_HNSW) went with the fact
   * scan it accelerated; the flag is retired.
   *
   * THE SCOPE FENCE IS ON THE ENTITY. The old fact scan read `userId IS
   * NONE` on knowledge_fact, where `userId` means "who said it" — mention
   * ingest stamps the speaker onto every fact — so on a per-user tenant
   * it excluded everything even before the table turned out to be empty.
   * On knowledge_entity `userId` means "private to one user", which is
   * the fence that was meant: a private entity never matches, a global
   * one is reachable through whoever named it.
   */
  private async findBestNameCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate | null> {
    // Cheapest, sharpest signal first: the nearest entity by edit distance
    // over the TRANSLITERATED name keys (0148). An embedding cannot tell
    // "Ivan Petrov" from "Иван Сидоров" (0.712, above most true pairs);
    // the key distance can, and it ranks every spelling of one name
    // correctly — measured on the Tier-0 corpus, "thomas brandt" against
    // the whole tenant:
    //
    //   0  Thomas Brandt     1  Томас Брандт (tomas brandt)
    //   3  थॉमस ब्रांट (thoms bramt)   4  توماس براندت (twms brndt)
    //   6  托马斯·勃兰特 (tuomasi bolante)
    //
    // Only CANDIDATE GENERATION, exactly like the cosine scan it runs
    // ahead of — the judge still decides on facts, so no threshold here
    // ever merges anything. `keyNeighbourCeiling` only bounds how far out
    // we are willing to spend a judge call.
    const neighbour = await this.findKeyNeighbour(db, name, type);
    if (neighbour) return neighbour;

    // What the key cannot reach: a name rendered by SOUND in another
    // script sits far away by edits ("ivan petrov" vs "yfn bytrwf" is
    // 0.64) and close by meaning (bge-m3 cosine 0.739).
    const q = await this.embedder.embed(`name: ${name}`);
    const rows = await this.queryNameCandidates(db, q, type);
    const best = rows[0];
    if (!best || best.sim < this.cosineFloor) return null;
    return {
      entityId: String(best.entityId),
      canonicalName: best.ename,
      cosine: best.sim,
      matchKind: 'embedding',
    };
  }

  /**
   * Nearest entity by edit distance over the transliterated name keys.
   *
   * Returns the closest candidate of the SAME type whose NORMALISED
   * distance (edits ÷ longer key) is within the ceiling, else null so the
   * caller falls through to the embedding scan — which still earns its
   * place on the cases a string comparison cannot reach: a script that
   * writes a foreign name by sound lands far away by edits
   * ("ivan petrov" vs "yfn bytrwf" is 0.64) and close by meaning.
   *
   * The ceiling is a RECALL bound on judge cost, not a merge rule.
   * Measured on the Tier-0 corpus: true pairs run 0.08-0.24 (thomas ~
   * tomas 0.08, maria ~ mariya alvarez 0.14, nadia ~ nadiya khaddad
   * 0.14), the nearest genuinely-different pair is "ivan petrov" ~ "ivan
   * sidorov" at 0.33, and aarav ~ arv srma is also 0.33. So the bands
   * touch here too — 0.35 deliberately admits BOTH, because the whole
   * point is that the judge, looking at facts, decides which is which.
   *
   * Reported as a `cosine` so the judge's hint keeps one scale: a
   * normalised distance is turned into a similarity (1 − d). It is not a
   * cosine and the two are not comparable, which is why `matchKind` on the
   * merge-log row records which scan produced the candidate.
   *
   * Never throws: on any failure (a tenant migrated before 0148, an older
   * SurrealDB without the string-distance function) it returns null and
   * the embedding scan runs, which is what ran before this existed.
   */
  private async findKeyNeighbour(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate | null> {
    const key = nameKey(name);
    if (key === '') return null;
    try {
      const [rows] = await db.query<
        [Array<{ entityId: unknown; canonicalName?: string; dist: number; matched: string }>]
      >(
        `SELECT id AS entityId, canonicalName,
                math::min(nameKeys.map(|$k| string::distance::levenshtein($key, $k))) AS dist,
                nameKeys[0] AS matched
           FROM knowledge_entity
          WHERE type = $type
            AND userId IS NONE
            AND mergedInto IS NONE
            AND nameKeys != NONE
            AND array::len(nameKeys) > 0
          ORDER BY dist ASC
          LIMIT 1`,
        { key, type },
      );
      const best = (rows ?? [])[0];
      if (!best || typeof best.dist !== 'number') return null;
      // Normalise by the longer of the two keys, so a one-edit difference
      // means something different on "bp" than on "orbital dynamics".
      const span = Math.max(key.length, String(best.matched ?? '').length, 1);
      const normalized = best.dist / span;
      // 0 is the exact-key case, which the deterministic ladder in
      // entity-upsert already reused before reaching here — seeing it
      // means that step declined (two entities shared the key), and
      // guessing between them is precisely what it refused to do.
      if (normalized <= 0 || normalized > this.keyNeighbourCeiling) return null;
      return {
        entityId: String(best.entityId),
        canonicalName: best.canonicalName,
        cosine: 1 - normalized,
        matchKind: 'translit',
      };
    } catch (err) {
      // WARN, not debug: a tenant where this scan cannot run is a tenant
      // where cross-script linking silently regressed to the embedding
      // path, and that has to be visible the first time it happens.
      this.logger.warn(
        `[ingest.inline_resolution] key-neighbour scan unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Nearest entities of `type` by cosine over their name embeddings.
   * `array::len(embedding) = array::len($q)` is the same width gate
   * the fact scans use: a row embedded in another space is skipped rather
   * than allowed to raise for the whole statement.
   */
  private async queryNameCandidates(
    db: Surreal,
    q: number[],
    type: string,
  ): Promise<Array<{ entityId: unknown; ename?: string; sim: number }>> {
    const [rows] = await db.query<[Array<{ entityId: unknown; ename?: string; sim: number }>]>(
      `SELECT id AS entityId, canonicalName AS ename,
              vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_entity
        WHERE type = $type
          AND embedding != NONE AND array::len(embedding) = array::len($q)
          AND userId IS NONE
          AND mergedInto IS NONE
        ORDER BY sim DESC
        LIMIT $k`,
      { q, type, k: this.candidateK },
    );
    return (rows as Array<{ entityId: unknown; ename?: string; sim: number }>) ?? [];
  }
}
