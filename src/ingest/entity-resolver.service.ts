import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, Surreal } from 'surrealdb';
import { EntityJudgeService } from '../ai/entity-judge.service';
import { traceArtifact } from '../common/debug-trace';
import { envFlagNotDisabled } from '../common/env-validation';
import { singleValuedPredicates } from '../ai/predicate-semantics';
import { conflictsOnSingleValuedSlot } from './same-name-conflict';
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
      similarity: judgeSimilarity(candidate.matchKind),
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
}
