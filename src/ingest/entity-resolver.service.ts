import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { EntityJudgeService } from '../ai/entity-judge.service';
import { traceArtifact } from '../common/debug-trace';
import { envFlagNotDisabled } from '../common/env-validation';
import { singleValuedPredicates } from '../ai/predicate-semantics';
import {
  compareIdentity,
  conflictsOnSingleValuedSlot,
  type IdentityMatch,
} from './same-name-conflict';
import {
  EntityCandidateService,
  judgeSimilarity,
  type NameCandidate,
} from './entity-candidates.service';

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
export interface ResolveByNameOptions {
  db: Surreal;
  name: string;
  type: string;
  incomingFacts: string[];
}

/** An entity the deterministic naming rungs found under the very same name. */
interface SameNameCandidate {
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

  constructor(
    private readonly config: ConfigService,
    private readonly judge: EntityJudgeService,
    private readonly candidates: EntityCandidateService,
  ) {
    this.enabled = envFlagNotDisabled(this.config.get<string>('INGEST_INLINE_RESOLUTION_ENABLED'));
    // Said once at boot, because "is it even on" was the first hour of
    // every linking investigation so far.
    this.logger.log(
      `[ingest.inline_resolution] ${this.enabled ? 'enabled' : 'disabled'}; ` +
        `judge ${this.judge.isAvailable() ? 'available' : 'unavailable'}; ${this.candidates.bounds()}`,
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
      for (const scan of this.candidates.scans(db, { name, type })) {
        for (const candidate of await scan()) {
          if (asked.has(candidate.entityId)) continue;
          asked.add(candidate.entityId);
          const reused = await this.judgeCandidate(db, { name, type, incoming, candidate });
          if (reused) return reused;
        }
      }
      if (asked.size === 0) {
        this.logger.debug(`[ingest.inline_resolution] no candidate (${type})`);
      }
      return null;
    } catch (err) {
      // Never block ingest — fall back to "create new".
      this.logger.warn(`[ingest.inline_resolution] failed (${type}): ${(err as Error).message}`);
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
      similarity: judgeSimilarity(candidate.matchKind),
      names: { a: candidate.canonicalName, b: name },
    });
    // The question and the answer, on the trace: which candidate, found
    // how, the caller's own evidence, and what the judge said. The
    // candidate's side is memory the caller may not read (any user, any
    // predicate, before any read fence) and the trace reaches the caller
    // as __trace and the tenant's trace buffer: its id and the size of
    // its evidence, never its name or facts.
    traceArtifact('ingest.entity.judge', {
      name,
      type,
      candidate: {
        entityId: candidate.entityId,
        matchKind: candidate.matchKind,
        cosine: candidate.cosine,
      },
      existingFactLines: lineCount(existingFacts),
      incoming,
      verdict,
      decision: verdict === 'same' ? 'reuse' : 'reject',
    });
    if (verdict === 'same') {
      this.logger.log(
        `[ingest.inline_resolution] reused ${candidate.entityId} ` +
          `(cos=${candidate.cosine.toFixed(3)})`,
      );
      return candidate.entityId;
    }
    // Logged, because a silent null here is indistinguishable from "no
    // candidate" and that is the question every linking miss asks first.
    this.logger.log(
      `[ingest.inline_resolution] judge said ${verdict} vs ` +
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
   * reuses the first candidate exactly as before. A `different` verdict
   * rules the candidate out.
   *
   * Without a judge (no model key, harness mode, the resolver off) the
   * same question is answered on the facts themselves (`contradictionCheck`): a
   * candidate the mention disagrees with on a single-valued slot, or on who
   * the person is — city, employer, profession — with nothing in common,
   * is not reused (same-name-conflict.ts — a wrong merge is invisible
   * forever, a wrong split is a pair the dedup pass judges later).
   * Measured by eval:entity-resolution: three same-name different people
   * of three were fused through `exact` with the judge off.
   *
   * `unsure` is no verdict — it is also what the judge answers when its
   * call fails — so it gets the judge-less answer: the candidate is kept
   * as a fallback only when nothing contradicts it. It used to be kept
   * whatever the facts said, and that alone fused the Munich vet and the
   * Lisbon engineer whenever the judge hedged or timed out (#815).
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
    const check = this.contradictionCheck(db, incomingFacts);
    // The first candidate nothing contradicted — one whose identity the
    // facts confirm ahead of one they merely leave open — kept while a
    // later one might still be judged outright "same".
    let fallback: string | undefined;
    let confirmed: string | undefined;
    for (const c of candidates) {
      const existingFacts = await this.judge
        .fetchTopFacts(db, c.entityId)
        .catch(() => '(no facts)');
      const empty = existingFacts === '(no facts)';
      const verdict = empty
        ? 'unsure'
        : await this.judge.judge(existingFacts, incoming, {
            cosine: 1,
            similarity: 'same-name',
            names: { a: c.canonicalName, b: name },
          });
      // A candidate with nothing on record has nothing to contradict.
      const evidence: IdentityMatch =
        verdict === 'unsure' && !empty ? await check(c.entityId) : 'unrelated';
      const contradicted = evidence === 'contradicts';
      // The candidate's side as an id and a size (see ingest.entity.judge).
      traceArtifact('ingest.entity.same_name', {
        name,
        candidate: { entityId: c.entityId },
        existingFactLines: empty ? 0 : lineCount(existingFacts),
        incoming,
        verdict,
        contradicted,
      });
      if (verdict === 'same') return { kind: 'reuse', entityId: c.entityId };
      if (verdict === 'unsure' && !contradicted) fallback ??= c.entityId;
      if (verdict === 'unsure' && evidence === 'agrees') confirmed ??= c.entityId;
    }
    const kept = confirmed ?? fallback;
    if (kept) return { kind: 'reuse', entityId: kept };
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
   * facts confirm, else the first they do not contradict, else a new
   * entity. A failing read counts as nothing to contradict.
   */
  private async sameNameBySlots(
    db: Surreal,
    candidates: ConfirmSameNameOptions['candidates'],
    incomingFacts: string[],
  ): Promise<SameNameOutcome> {
    const check = this.contradictionCheck(db, incomingFacts);
    // Several entities share the name: the mention goes to the one its
    // facts confirm, else to the first they do not contradict.
    let open: string | undefined;
    for (const c of candidates) {
      const evidence = await check(c.entityId);
      if (evidence === 'agrees') return { kind: 'reuse', entityId: c.entityId };
      if (evidence === 'unrelated') open ??= c.entityId;
    }
    if (open) return { kind: 'reuse', entityId: open };
    // Ids only: the name is memory content.
    this.logger.log(
      `[ingest.inline_resolution] same-name candidates ` +
        `${candidates.map((c) => c.entityId).join(', ')} contradicted by the mention's facts ` +
        `and no judge confirmed one — creating new`,
    );
    return { kind: 'distinct' };
  }

  /**
   * How the mention's facts meet an entity's, decided on the facts alone:
   * `contradicts` on a single-valued slot holding another value, else the
   * person's city / employer / profession compared (`compareIdentity`).
   * The entity's side is its live facts and its live edges — the
   * extractor files an employer and a city as edges, and the mention's
   * side already carries its edges as `kind: other` lines.
   * An ended fact or edge is history and contradicts nothing on the
   * identity attributes. The predicate registry is read once per mention.
   * Never throws: a failing read is `unrelated` (nothing to contradict).
   */
  private contradictionCheck(
    db: Surreal,
    incomingFacts: string[],
  ): (entityId: string) => Promise<IdentityMatch> {
    let singleValued: Promise<Set<string>> | undefined;
    const registry = () =>
      (singleValued ??= db
        .query<[Array<{ predicateId: string; semantics: string }>]>(
          `SELECT predicateId, semantics FROM knowledge_predicate;`,
        )
        .then(([rows]) => singleValuedPredicates(rows ?? [])));
    return async (entityId) => {
      try {
        type Held = { predicate: string; object: string; ended?: boolean };
        const eid = new StringRecordId(entityId);
        const [facts] = await db.query<[Held[]]>(
          `SELECT predicate, object, (validUntil != NONE AND validUntil <= time::now()) AS ended
             FROM knowledge_fact
            WHERE entityId = $eid AND status = 'active' AND retractedAt IS NONE`,
          { eid },
        );
        const [edges] = await db.query<[Held[]]>(
          `SELECT kind AS predicate, out.canonicalName AS object,
                  (validUntil != NONE AND validUntil <= time::now()) AS ended
             FROM knowledge_edge
            WHERE in = $eid AND invalidatedAt IS NONE AND out.canonicalName != NONE`,
          { eid },
        );
        const live = [...(facts ?? []), ...(edges ?? [])].filter((h) => !h.ended);
        if (conflictsOnSingleValuedSlot(incomingFacts, facts ?? [], await registry())) {
          return 'contradicts';
        }
        return compareIdentity(incomingFacts, live);
      } catch {
        return 'unrelated';
      }
    };
  }
}

/** Lines of a rendered fact list — the trace's measure of the candidate's evidence. */
function lineCount(text: string): number {
  return text.split('\n').filter((l) => l.trim().length > 0).length;
}
