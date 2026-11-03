import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { EmbedderService } from '../ai/embedder.service';
import type { JudgeContext } from '../ai/entity-judge.service';
import { nameKey, nameKeyInitials, nameKeyWords } from '../common/name-key';

/**
 * The string-side candidate generation for entity resolution: which
 * existing entities a name might be, by the name alone. Shared by the
 * inline resolver at ingest (entity-resolver.service.ts), which adds an
 * embedding scan behind these, and the nightly dedup pass
 * (dreams/dedup.service.ts), which used to block on name-embedding cosine
 * only — the one signal measured unable to tell "Ivan Petrov" from "Иван
 * Сидоров" (common/name-key.ts).
 *
 * MULTI-PASS BLOCKING. Each scan is a different kind of evidence that two
 * names may be one (Papadakis et al., "Blocking and Filtering Techniques
 * for Entity Resolution", 2020) and proposes at most ONE entity — two
 * matches are an ambiguity a string must not settle. Nothing here merges:
 * every candidate goes to the fact-reading judge.
 */

/** A candidate for the judge, and which scan found it. */
export interface NameCandidate {
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

export function judgeSimilarity(
  kind: NameCandidate['matchKind'],
): NonNullable<JudgeContext['similarity']> {
  return JUDGE_SIMILARITY[kind];
}

/** Whose candidates: a name of a type, never the entity asking (the dedup seed). */
export interface NameScanQuery {
  name: string;
  type: string;
  excludeId?: string | undefined;
}

/**
 * The fence every scan shares: tenant-global (a private entity never
 * matches), not merged away, and not the entity whose candidates these are.
 */
function fence(excludeId: string | undefined): string {
  return (
    'AND userId IS NONE AND mergedInto IS NONE' +
    (excludeId ? ' AND id != type::record($excludeId)' : '')
  );
}

@Injectable()
export class EntityCandidateService {
  private readonly logger = new Logger(EntityCandidateService.name);
  private readonly keyNeighbourCeiling: number;
  private readonly cosineFloor: number;
  private readonly candidateK: number;

  constructor(
    config: ConfigService,
    private readonly embedder: EmbedderService,
  ) {
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
      config.get<string>('INGEST_INLINE_RESOLUTION_COSINE_FLOOR', '0.65'),
    );
    this.candidateK = parseInt(config.get<string>('INGEST_INLINE_RESOLUTION_CANDIDATES', '5'), 10);
    // How far out, in normalised edit distance over transliterated name
    // keys, a candidate is still worth a judge call. See findKeyNeighbour.
    this.keyNeighbourCeiling = parseFloat(
      config.get<string>('INGEST_INLINE_RESOLUTION_KEY_DISTANCE', '0.35'),
    );
  }

  /**
   * Every scan the inline resolver runs: the string scans, then — for what
   * a key cannot reach, a name rendered by SOUND in another script, far by
   * edits ("ivan petrov" vs "yfn bytrwf" is 0.64) and close by meaning
   * (bge-m3 cosine 0.739) — the nearest name embedding.
   */
  scans(db: Surreal, q: NameScanQuery): Array<() => Promise<NameCandidate[]>> {
    return [
      ...this.nameScans(db, q),
      async () => {
        const c = await this.findEmbeddingCandidate(db, q);
        return c ? [c] : [];
      },
    ];
  }

  /** The bounds the scans spend judge calls within — for the boot log. */
  bounds(): string {
    return `key-distance ceiling ${this.keyNeighbourCeiling}, cosine floor ${this.cosineFloor}`;
  }

  /**
   * The string scans, one blocking key each, in the order they run:
   * transliterated-key edit distance, a name that is a part of the other,
   * initials, a shared word no other entity carries. The nightly dedup runs
   * these alone — it holds each entity's stored name vector already.
   *
   * MULTI-PASS BLOCKING, not a best-first chain. Each key is a different
   * kind of evidence that two names may be one (Papadakis et al., "Blocking
   * and Filtering Techniques for Entity Resolution", 2020): the chain
   * stopped at the first key that found anything, so the nearest spelling
   * — a sibling, a namesake — was the only thing the judge ever saw, and
   * "Bob King" never met "Robert King" at all (eval:entity-resolution).
   * Every key proposes at most ONE entity, the ambiguity rule the ladder
   * keeps everywhere, so judge calls stay bounded by the number of keys.
   */
  nameScans(db: Surreal, q: NameScanQuery): Array<() => Promise<NameCandidate[]>> {
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
      async () => one(await this.findKeyNeighbour(db, q)),

      // A NAME THAT IS A PART OF A LONGER NAME. "Артём" three turns after
      // "Артём Соколов" is an edit distance of eight — far outside the
      // ceiling — and by meaning a first name alone sits nowhere near the
      // full one; on the prod tenant the first name became its own node
      // beside the person, every time. A key that is a whole token of an
      // existing key (or the reverse) names a candidate the judge can
      // decide on with facts; two such entities name an ambiguity nobody
      // here can decide, and that is a create, not a guess.
      async () => one(await this.findTokenSubsetCandidate(db, q)),

      // An acronym and its expansion: "IBM" shares no letter run with
      // "International Business Machines" that an edit distance or an
      // embedding of a three-letter string would see.
      async () => one(await this.findInitialsCandidate(db, q)),

      // A word only one known entity carries — in practice the surname, or
      // the distinctive word of a company name. "Bob King" / "Robert King",
      // "Sasha Volkov" / "Alexander Volkov", "Жуан Силва" / "João Silva":
      // the given names differ past any edit ceiling (a nickname, a sound
      // rendering), the surname does not.
      () => this.findSharedWordCandidates(db, q),
    ];
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
    { name, type, excludeId }: NameScanQuery,
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
            ${fence(excludeId)}
            AND nameKeys != NONE
            AND array::len(nameKeys) > 0
          ORDER BY dist ASC
          LIMIT 1`,
        { key, type, excludeId },
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
        `[entity.candidates] key-neighbour scan unavailable: ${(err as Error).message}`,
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
    { name, type, excludeId }: NameScanQuery,
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
            ${fence(excludeId)}
            AND nameKeys != NONE
            AND array::len(nameKeys.filter(|$k| $k != $key AND (
                  string::starts_with($k, $pre) OR string::ends_with($k, $suf)
                  OR string::contains($k, $mid)
                  OR string::starts_with($key, $k + ' ') OR string::ends_with($key, ' ' + $k)
                ))) > 0
          LIMIT 3`,
        { key, type, excludeId, pre: `${key} `, suf: ` ${key}`, mid: ` ${key} ` },
      );
      const hits = (rows ?? [])
        .map((r) => ({
          ...r,
          matched: (Array.isArray(r.nameKeys) ? (r.nameKeys as string[]) : []).find(
            (k) => isPart(k, key) || isPart(key, k),
          ),
        }))
        .filter((r): r is typeof r & { matched: string } => typeof r.matched === 'string');
      const hit = await this.oneIdentity(db, hits);
      if (!hit) return null;
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
        `[entity.candidates] token-subset scan unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The one entity of `type` whose name is the initials of the mention's,
   * or whose initials are the mention's name: "ibm" against "international
   * business machines", either way round. Unique matches only; never
   * throws (the key-neighbour posture).
   */
  private async findInitialsCandidate(
    db: Surreal,
    { name, type, excludeId }: NameScanQuery,
  ): Promise<NameCandidate | null> {
    const key = nameKey(name);
    if (key === '') return null;
    const initials = nameKeyInitials(key);
    try {
      const [rows] = await db.query<[Array<{ entityId: unknown; canonicalName?: string }>]>(
        `SELECT id AS entityId, canonicalName
           FROM knowledge_entity
          WHERE type = $type
            ${fence(excludeId)}
            AND nameKeys != NONE
            AND array::len(nameKeys.filter(|$k|
                  ($initials != '' AND $k = $initials)
                  OR (string::contains($k, ' ')
                      AND array::join(string::split($k, ' ').map(|$w| string::slice($w, 0, 1)), '') = $key)
                )) > 0
          LIMIT 2`,
        { key, initials, type, excludeId },
      );
      const hit = await this.oneIdentity(db, rows ?? []);
      if (!hit) return null;
      return {
        entityId: String(hit.entityId),
        canonicalName: hit.canonicalName,
        cosine: 1,
        matchKind: 'initials',
      };
    } catch (err) {
      this.logger.warn(`[entity.candidates] initials scan unavailable: ${(err as Error).message}`);
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
    { name, type, excludeId }: NameScanQuery,
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
              ${fence(excludeId)}
              AND nameKeys != NONE
              AND array::len(nameKeys.filter(|$k| string::split($k, ' ') CONTAINS $word)) > 0
            LIMIT 2`,
          { word, type, excludeId },
        );
        const hit = await this.oneIdentity(db, rows ?? []);
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
        `[entity.candidates] shared-word scan unavailable: ${(err as Error).message}`,
      );
    }
    return out;
  }

  /**
   * The one identity the rows name, or undefined when they name several.
   * Two rows already joined by an `identity_of` edge are ONE identity: the
   * nightly dedup links duplicates rather than deleting them, so without
   * this the surname it has just unified ("Alexander Volkov" and
   * "Александр Волков") would read as two carriers forever and the next
   * "Sasha Volkov" would never be asked about (eval:entity-resolution,
   * deferred). The first row stands for the identity.
   */
  private async oneIdentity<T extends { entityId: unknown }>(
    db: Surreal,
    rows: T[],
  ): Promise<T | undefined> {
    if (rows.length === 1) return rows[0];
    if (rows.length !== 2) return undefined;
    const [a, b] = rows.map((r) => new StringRecordId(String(r.entityId)));
    const [edges] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM knowledge_edge
        WHERE kind = 'identity_of'
          AND ((in = $a AND out = $b) OR (in = $b AND out = $a))
        LIMIT 1`,
      { a, b },
    );
    return (edges ?? []).length > 0 ? rows[0] : undefined;
  }

  /**
   * The nearest entity by name embedding, when it clears the cosine floor.
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
  private async findEmbeddingCandidate(
    db: Surreal,
    { name, type, excludeId }: NameScanQuery,
  ): Promise<NameCandidate | null> {
    const q = await this.embedder.embed(`name: ${name}`);
    const best = (await this.queryNameCandidates(db, { q, type, excludeId }))[0];
    if (!best || best.sim < this.cosineFloor) return null;
    return {
      entityId: String(best.entityId),
      canonicalName: best.ename,
      cosine: best.sim,
      matchKind: 'embedding',
    };
  }

  /**
   * Nearest entities of `type` by cosine over their name embeddings.
   * `array::len(embedding) = array::len($q)` is the same width gate
   * the fact scans use: a row embedded in another space is skipped rather
   * than allowed to raise for the whole statement.
   */
  private async queryNameCandidates(
    db: Surreal,
    { q, type, excludeId }: { q: number[]; type: string; excludeId?: string | undefined },
  ): Promise<Array<{ entityId: unknown; ename?: string; sim: number }>> {
    const [rows] = await db.query<[Array<{ entityId: unknown; ename?: string; sim: number }>]>(
      `SELECT id AS entityId, canonicalName AS ename,
              vector::similarity::cosine(embedding, $q) AS sim
         FROM knowledge_entity
        WHERE type = $type
          AND embedding != NONE AND array::len(embedding) = array::len($q)
          ${fence(excludeId)}
        ORDER BY sim DESC
        LIMIT $k`,
      { q, type, excludeId, k: this.candidateK },
    );
    return (rows as Array<{ entityId: unknown; ename?: string; sim: number }>) ?? [];
  }
}
