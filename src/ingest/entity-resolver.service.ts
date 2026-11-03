import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import { EntityJudgeService, type JudgeContext } from '../ai/entity-judge.service';
import { traceArtifact } from '../common/debug-trace';
import { envFlagNotDisabled } from '../common/env-validation';
import { nameKey, nameKeyInitials, nameKeyWords } from '../common/name-key';
import { singleValuedPredicates } from '../ai/predicate-semantics';
import { conflictsOnSingleValuedSlot } from './same-name-conflict';

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
 * Gated by INGEST_INLINE_RESOLUTION_ENABLED (default on). Any failure
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
  matchKind: 'translit' | 'embedding' | 'name-part' | 'shared-word' | 'initials';
}

/** How the judge's prompt names each scan's similarity. */
const JUDGE_SIMILARITY: Record<
  NameCandidate['matchKind'],
  NonNullable<JudgeContext['similarity']>
> = {
  translit: 'transliteration',
  embedding: 'embedding',
  'name-part': 'name-part',
  'shared-word': 'shared-word',
  initials: 'initials',
};

export interface ResolveByNameOptions {
  db: Surreal;
  name: string;
  type: string;
  incomingFacts: string[];
}

/** An entity the deterministic naming rungs found under the very same name. */
export interface SameNameCandidate {
  entityId: string;
  canonicalName?: string | undefined;
}

export interface ConfirmSameNameOptions {
  db: Surreal;
  name: string;
  /** In the order the rung found them; the first non-contradicted one wins. */
  candidates: SameNameCandidate[];
  incomingFacts: string[];
}

/**
 * `reuse` — file the mention under `entityId`; `distinct` — every candidate
 * was judged a different thing that shares the name, so mint a new entity.
 */
export type SameNameOutcome = { kind: 'reuse'; entityId: string } | { kind: 'distinct' };

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
    this.enabled = envFlagNotDisabled(this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED'));
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
      const incoming =
        incomingFacts.length > 0 ? incomingFacts.map((f) => `- ${f}`).join('\n') : '(no facts)';
      // Each blocking key proposes at most one entity, so a "different" on
      // the nearest spelling (a sibling, a namesake) no longer ends the
      // search before the entity that shares the surname is even asked. A
      // scan runs only when every candidate before it was refused — a hit
      // on the key scan spends no embedding.
      const asked = new Set<string>();
      for (const scan of this.nameCandidateScans(db, name, type)) {
        for (const candidate of await scan()) {
          if (asked.has(candidate.entityId)) continue;
          asked.add(candidate.entityId);
          const reused = await this.judgeCandidate(db, { name, type, incoming, candidate });
          if (reused) return reused;
        }
      }
      if (asked.size === 0) {
        this.logger.debug(`[ingest.inline_resolution] no candidate for "${name}" (${type})`);
      }
      return null;
    } catch (err) {
      // Never block ingest — fall back to "create new".
      this.logger.warn(
        `[ingest.inline_resolution] failed for "${name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** One candidate before the judge: its id when the verdict is `same`, else null. */
  private async judgeCandidate(
    db: Surreal,
    {
      name,
      type,
      incoming,
      candidate,
    }: { name: string; type: string; incoming: string; candidate: NameCandidate },
  ): Promise<string | null> {
    const existingFacts = await this.judge.fetchTopFacts(db, candidate.entityId);
    // The judge gets both NAMES and is told which scan found the
    // candidate. Two spellings of one person in two scripts carry the
    // same facts in two languages, and without the names that reads as
    // no shared evidence at all — measured: "Фёдор Волков" was judged
    // different from "Fyodor Volkov" with the same employer and role.
    const verdict = await this.judge.judge(existingFacts, incoming, {
      cosine: candidate.cosine,
      similarity: JUDGE_SIMILARITY[candidate.matchKind],
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
      decision: verdict === 'same' ? 'reuse' : 'reject',
    });
    if (verdict === 'same') {
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
        `${candidate.entityId} (${candidate.matchKind}=${candidate.cosine.toFixed(3)})`,
    );
    return null;
  }

  /**
   * The check the deterministic rungs of the naming ladder (exact
   * canonical name / alias, identical transliterated key) used to skip.
   * They reused the first entity carrying the same name, unconditionally
   * and before anything looked at a fact — so two different people who
   * share a name became one node the moment the second was mentioned: an
   * "Anna Schmidt" who is a vet in Munich and an "Anna Schmidt" who is a
   * software engineer in Lisbon (#815). Once fused, nothing downstream can
   * see it: the dreams dedup looks for PAIRS, and there is only one node.
   *
   * The name stays the strong signal it is: the judge is asked only
   * whether the facts CONTRADICT it (the `same-name` hint), and only when
   * there is something to contradict — the mention brings facts AND the
   * candidate holds some. A mention with no facts or a candidate with none
   * reuses the first candidate exactly as before; so does `unsure`. Only a
   * `different` verdict on every candidate mints a new entity.
   *
   * Without a judge (no model key, harness mode, the resolver off) the
   * same question is answered on the slots themselves: a candidate whose
   * single-valued facts the mention disagrees with is not reused
   * (same-name-conflict.ts — a wrong merge is invisible forever, a wrong
   * split is a pair the dedup pass judges later). Measured by
   * eval:entity-resolution: three same-name different people of three were
   * fused through `exact` with the judge off.
   *
   * Never throws: a failing fact read counts as "nothing to contradict".
   */
  async confirmSameName({
    db,
    name,
    candidates,
    incomingFacts,
  }: ConfirmSameNameOptions): Promise<SameNameOutcome> {
    const first = candidates[0];
    if (!first) return { kind: 'distinct' };
    if (incomingFacts.length === 0) return { kind: 'reuse', entityId: first.entityId };
    if (!this.isEnabled()) return this.sameNameBySlots(db, candidates, incomingFacts);
    const incoming = incomingFacts.map((f) => `- ${f}`).join('\n');
    // The first candidate nothing contradicted, kept while a later one
    // might still be judged outright "same".
    let fallback: string | undefined;
    for (const c of candidates) {
      const existingFacts = await this.judge
        .fetchTopFacts(db, c.entityId)
        .catch(() => '(no facts)');
      const verdict =
        existingFacts === '(no facts)'
          ? 'unsure'
          : await this.judge.judge(existingFacts, incoming, {
              cosine: 1,
              similarity: 'same-name',
              names: { a: c.canonicalName, b: name },
            });
      traceArtifact('ingest.entity.same_name', {
        name,
        candidate: { entityId: c.entityId, canonicalName: c.canonicalName },
        existingFacts,
        incoming,
        verdict,
      });
      if (verdict === 'same') return { kind: 'reuse', entityId: c.entityId };
      if (verdict === 'unsure') fallback ??= c.entityId;
    }
    if (fallback) return { kind: 'reuse', entityId: fallback };
    // Ids only: the name is memory content.
    this.logger.log(
      `[ingest.inline_resolution] same-name candidates ` +
        `${candidates.map((c) => c.entityId).join(', ')} contradicted by the mention's facts — ` +
        `creating new`,
    );
    return { kind: 'distinct' };
  }

  /**
   * The judge-less same-name decision: the first candidate the mention's
   * facts do not disagree with on a single-valued slot, else a new entity.
   * A failing read counts as nothing to disagree with.
   */
  private async sameNameBySlots(
    db: Surreal,
    candidates: ConfirmSameNameOptions['candidates'],
    incomingFacts: string[],
  ): Promise<SameNameOutcome> {
    try {
      const [registry] = await db.query<[Array<{ predicateId: string; semantics: string }>]>(
        `SELECT predicateId, semantics FROM knowledge_predicate;`,
      );
      const singleValued = singleValuedPredicates(registry ?? []);
      for (const c of candidates) {
        const [facts] = await db.query<[Array<{ predicate: string; object: string }>]>(
          `SELECT predicate, object FROM knowledge_fact
            WHERE entityId = $eid AND status = 'active' AND retractedAt IS NONE`,
          { eid: new StringRecordId(c.entityId) },
        );
        if (!conflictsOnSingleValuedSlot(incomingFacts, facts ?? [], singleValued)) {
          return { kind: 'reuse', entityId: c.entityId };
        }
      }
    } catch {
      return { kind: 'reuse', entityId: candidates[0]!.entityId };
    }
    // Ids only: the name is memory content.
    this.logger.log(
      `[ingest.inline_resolution] same-name candidates ` +
        `${candidates.map((c) => c.entityId).join(', ')} disagree with the mention on a ` +
        `single-valued slot and no judge is available — creating new`,
    );
    return { kind: 'distinct' };
  }

  /**
   * The scans that propose candidates to the judge, one blocking key
   * each, in the order they run: transliterated-key edit distance, a name that is a
   * part of the other, initials, a shared word no other entity carries,
   * then cosine over the entities' own name embeddings.
   *
   * MULTI-PASS BLOCKING, not a best-first chain. Each key is a different
   * kind of evidence that two names may be one (Papadakis et al., "Blocking
   * and Filtering Techniques for Entity Resolution", 2020): the chain
   * stopped at the first key that found anything, so the nearest spelling
   * — a sibling, a namesake — was the only thing the judge ever saw, and
   * "Bob King" never met "Robert King" at all (eval:entity-resolution).
   * Every key proposes at most ONE entity, the ambiguity rule the ladder
   * keeps everywhere, so judge calls stay bounded by the number of keys.
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
  private nameCandidateScans(
    db: Surreal,
    name: string,
    type: string,
  ): Array<() => Promise<NameCandidate[]>> {
    const one = (c: NameCandidate | null): NameCandidate[] => (c ? [c] : []);
    return [
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
      // Only CANDIDATE GENERATION, exactly like every scan below — the judge
      // still decides on facts, so no threshold here ever merges anything.
      // `keyNeighbourCeiling` only bounds how far out we spend a judge call.
      async () => one(await this.findKeyNeighbour(db, name, type)),

      // A NAME THAT IS A PART OF A LONGER NAME. "Артём" three turns after
      // "Артём Соколов" is an edit distance of eight — far outside the
      // ceiling — and by meaning a first name alone sits nowhere near the
      // full one; on the prod tenant the first name became its own node
      // beside the person, every time. A key that is a whole token of an
      // existing key (or the reverse) names a candidate the judge can
      // decide on with facts; two such entities name an ambiguity nobody
      // here can decide, and that is a create, not a guess.
      async () => one(await this.findTokenSubsetCandidate(db, name, type)),

      // An acronym and its expansion: "IBM" shares no letter run with
      // "International Business Machines" that an edit distance or an
      // embedding of a three-letter string would see.
      async () => one(await this.findInitialsCandidate(db, name, type)),

      // A word only one known entity carries — in practice the surname, or
      // the distinctive word of a company name. "Bob King" / "Robert King",
      // "Sasha Volkov" / "Alexander Volkov", "Жуан Силва" / "João Silva":
      // the given names differ past any edit ceiling (a nickname, a sound
      // rendering), the surname does not.
      () => this.findSharedWordCandidates(db, name, type),

      // What the key cannot reach: a name rendered by SOUND in another
      // script sits far away by edits ("ivan petrov" vs "yfn bytrwf" is
      // 0.64) and close by meaning (bge-m3 cosine 0.739).
      async () => one(await this.findEmbeddingCandidate(db, name, type)),
    ];
  }

  /** The nearest entity by name embedding, when it clears the cosine floor. */
  private async findEmbeddingCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate | null> {
    const q = await this.embedder.embed(`name: ${name}`);
    const best = (await this.queryNameCandidates(db, q, type))[0];
    if (!best || best.sim < this.cosineFloor) return null;
    return {
      entityId: String(best.entityId),
      canonicalName: best.ename,
      cosine: best.sim,
      matchKind: 'embedding',
    };
  }

  /**
   * The one entity of `type` whose name is the initials of the mention's,
   * or whose initials are the mention's name: "ibm" against "international
   * business machines", either way round. Unique matches only; never
   * throws (the key-neighbour posture).
   */
  private async findInitialsCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate | null> {
    const key = nameKey(name);
    if (key === '') return null;
    const initials = nameKeyInitials(key);
    try {
      const [rows] = await db.query<[Array<{ entityId: unknown; canonicalName?: string }>]>(
        `SELECT id AS entityId, canonicalName
           FROM knowledge_entity
          WHERE type = $type
            AND userId IS NONE
            AND mergedInto IS NONE
            AND nameKeys != NONE
            AND array::len(nameKeys.filter(|$k|
                  ($initials != '' AND $k = $initials)
                  OR (string::contains($k, ' ')
                      AND array::join(string::split($k, ' ').map(|$w| string::slice($w, 0, 1)), '') = $key)
                )) > 0
          LIMIT 2`,
        { key, initials, type },
      );
      const hit = rows?.length === 1 ? rows[0] : undefined;
      if (!hit) return null;
      return {
        entityId: String(hit.entityId),
        canonicalName: hit.canonicalName,
        cosine: 1,
        matchKind: 'initials',
      };
    } catch (err) {
      this.logger.warn(
        `[ingest.inline_resolution] initials scan unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * For each word of the mention's key, the entity of `type` carrying it —
   * when exactly one does. A word several entities share (a common given
   * name, "bank", "studio") names a crowd, not a candidate, and is skipped:
   * the same ambiguity rule as the token-subset scan. Never throws.
   */
  private async findSharedWordCandidates(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate[]> {
    const key = nameKey(name);
    const words = nameKeyWords(key);
    if (words.length < 2) return [];
    const out: NameCandidate[] = [];
    try {
      for (const word of words) {
        const [rows] = await db.query<[Array<{ entityId: unknown; canonicalName?: string }>]>(
          `SELECT id AS entityId, canonicalName
             FROM knowledge_entity
            WHERE type = $type
              AND userId IS NONE
              AND mergedInto IS NONE
              AND nameKeys != NONE
              AND array::len(nameKeys.filter(|$k| string::split($k, ' ') CONTAINS $word)) > 0
            LIMIT 2`,
          { word, type },
        );
        const hit = rows?.length === 1 ? rows[0] : undefined;
        if (!hit) continue;
        out.push({
          entityId: String(hit.entityId),
          canonicalName: hit.canonicalName,
          // The share of the mention's key the shared word covers.
          cosine: word.length / key.length,
          matchKind: 'shared-word',
        });
      }
    } catch (err) {
      this.logger.warn(
        `[ingest.inline_resolution] shared-word scan unavailable: ${(err as Error).message}`,
      );
    }
    return out;
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
   * The one entity of `type` whose name key contains the incoming key as
   * a whole token (or is contained by it): "artem" ⊂ "artem sokolov",
   * "helio" ⊂ "helio robotics". Candidate generation only — the judge
   * decides. Null when none or when MORE than one match: two people
   * sharing a first name is exactly the case a string must not decide.
   * Never throws (the key-neighbour posture).
   */
  private async findTokenSubsetCandidate(
    db: Surreal,
    name: string,
    type: string,
  ): Promise<NameCandidate | null> {
    const key = nameKey(name);
    if (key === '') return null;
    const isPart = (a: string, b: string): boolean =>
      a !== b && (a.startsWith(`${b} `) || a.endsWith(` ${b}`) || a.includes(` ${b} `));
    try {
      const [rows] = await db.query<
        [Array<{ entityId: unknown; canonicalName?: string; nameKeys?: unknown }>]
      >(
        `SELECT id AS entityId, canonicalName, nameKeys
           FROM knowledge_entity
          WHERE type = $type
            AND userId IS NONE
            AND mergedInto IS NONE
            AND nameKeys != NONE
            AND array::len(nameKeys.filter(|$k| $k != $key AND (
                  string::starts_with($k, $pre) OR string::ends_with($k, $suf)
                  OR string::contains($k, $mid)
                  OR string::starts_with($key, $k + ' ') OR string::ends_with($key, ' ' + $k)
                ))) > 0
          LIMIT 3`,
        { key, type, pre: `${key} `, suf: ` ${key}`, mid: ` ${key} ` },
      );
      const hits = (rows ?? [])
        .map((r) => ({
          ...r,
          matched: (Array.isArray(r.nameKeys) ? (r.nameKeys as string[]) : []).find(
            (k) => isPart(k, key) || isPart(key, k),
          ),
        }))
        .filter((r): r is typeof r & { matched: string } => typeof r.matched === 'string');
      if (hits.length !== 1) return null;
      const hit = hits[0]!;
      const span = Math.max(key.length, hit.matched.length, 1);
      return {
        entityId: String(hit.entityId),
        canonicalName: hit.canonicalName,
        // The judge's hint on one scale with the key scan: the share of
        // the longer key the shorter one covers.
        cosine: Math.min(key.length, hit.matched.length) / span,
        matchKind: 'name-part',
      };
    } catch (err) {
      this.logger.warn(
        `[ingest.inline_resolution] token-subset scan unavailable: ${(err as Error).message}`,
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
