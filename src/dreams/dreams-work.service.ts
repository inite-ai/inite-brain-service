import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import {
  ENTITY_JUDGE_SYSTEM,
  EntityJudgeService,
  entityJudgeUserContent,
} from '../ai/entity-judge.service';
import { ReadPinService } from '../episodes/read-pin.service';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type PairsTokenPayload } from '../common/harness-work-token';
import {
  CORROBORATE_JUDGE_SYSTEM,
  DreamsCorroborateService,
  corroborateUserContent,
  type ActiveFactRow,
} from './corroborate.service';
import { DreamsDedupService } from './dedup.service';
import {
  DreamsResolverService,
  RESOLVE_JUDGE_SYSTEM,
  resolveJudgeUserContent,
  type CompetingFactRow,
} from './resolver.service';
import { alreadyJudged, loadPairMemo, pairSignature, recordPairVerdict } from './pair-memo';

/** Pairs per batch: one prompt, one reply, a handful of verdicts. */
export const PAIRS_PER_BATCH = 10;

/** What a submitted batch of verdicts did. */
export interface PairsSubmitOutcome {
  pairs: number;
  applied: number;
  unsure: number;
  /** The evidence moved since the batch was taken; asked again later. */
  stale: number;
  /** No verdict for the pair in the reply. */
  missing: number;
}

const ENTITY_VERDICTS = ['same', 'different', 'unsure'] as const;
const RESOLVE_VERDICTS = ['a_wins', 'b_wins', 'unsure'] as const;
const CORROBORATE_VERDICTS = ['same_assertion', 'different', 'unsure'] as const;

/**
 * Harness mode (#819): the two nightly judges of dreams — "are these two
 * entities one thing?" (dedup) and "which of two competing facts holds?"
 * (resolve) — answered by the connected agent's model in batches instead
 * of the server's. The candidates are exactly the pass's own (same
 * finders, same memo 0173), the prompt is the judge's own with a batch
 * preamble, and a verdict is applied by the pass's own writes: an
 * identity_of link, a supersede, or a memo row for `different`/`unsure`.
 *
 * Nothing is claimed: a batch two agents took twice is applied twice
 * idempotently (the identity edge exists, the loser is no longer
 * competing). The token carries the evidence signature each pair was
 * asked on; a pair whose evidence moved since is left for the next take.
 *
 * Scope: a caller reads what its credential reads — tenant-global facts,
 * plus its own user's. A competing pair belongs to one slice and is only
 * offered to that slice's caller.
 */
@Injectable()
export class DreamsWorkService {
  private readonly logger = new Logger(DreamsWorkService.name);

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly dedup: DreamsDedupService,
    private readonly resolver: DreamsResolverService,
    private readonly judge: EntityJudgeService,
    private readonly corroborate: DreamsCorroborateService,
    @Optional() private readonly readPin?: ReadPinService,
  ) {}

  async takeEntityMatch(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (!this.dedup.configured()) return null;
    const max = batchSize(opts.max);
    return this.surreal.withCompany(companyId, async (db) => {
      const candidates = await this.dedup.findCandidates(db, await this.pin(companyId));
      if (candidates.length === 0) return null;
      const memo = await loadPairMemo(db, 'dedup');
      const pairs: Array<[string, string, string]> = [];
      const blocks: string[] = [];
      for (const cand of candidates) {
        if (pairs.length >= max) break;
        if (await this.dedup.identityEdgeExists(db, cand.aId, cand.bId)) continue;
        const evidence = await this.entityEvidence(db, {
          aId: cand.aId,
          bId: cand.bId,
          userId: opts.userId,
        });
        if (!evidence) continue;
        const pairKey = `${cand.aId}|${cand.bId}`;
        if (alreadyJudged(memo, { pairKey, signature: evidence.signature })) continue;
        pairs.push([cand.aId, cand.bId, evidence.signature]);
        const names = await this.names(db, [cand.aId, cand.bId]);
        blocks.push(
          `Pair p${pairs.length}:\n` +
            entityJudgeUserContent(evidence.a, evidence.b, {
              cosine: cand.cosine,
              names: { a: names.get(cand.aId), b: names.get(cand.bId) },
            }),
        );
      }
      if (pairs.length === 0) return null;
      this.logger.log(`harness work taken ${companyId}: entity_match pairs=${pairs.length}`);
      return this.issue({
        kind: 'entity_match',
        companyId,
        userId: opts.userId,
        pairs,
        systemPrompt: batchInstructions('pair', 'p') + ENTITY_JUDGE_SYSTEM,
        userContent: blocks.join('\n\n'),
        verdicts: ENTITY_VERDICTS,
      });
    });
  }

  async takeFactConflict(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (!this.resolver.configured()) return null;
    const max = batchSize(opts.max);
    const pin = await this.pin(companyId);
    return this.surreal.withCompany(companyId, async (db) => {
      const found = await this.resolver.findCompetingPairs(db, pin);
      const memo = await loadPairMemo(db, 'resolve');
      const pairs: Array<[string, string, string]> = [];
      const blocks: string[] = [];
      for (const pair of found) {
        if (pairs.length >= max) break;
        // One slice per caller: a user's pair to that user, a tenant pair
        // to a tenant-global caller.
        if ((pair.a.userId ?? undefined) !== opts.userId) continue;
        const ctxFacts = await this.conflictContext(db, pair.a, pin);
        const signature = pairSignature(pair.a.object, pair.b.object, ctxFacts);
        const pairKey = `${String(pair.a.id)}|${String(pair.b.id)}`;
        if (alreadyJudged(memo, { pairKey, signature })) continue;
        pairs.push([String(pair.a.id), String(pair.b.id), signature]);
        blocks.push(`Pair p${pairs.length}:\n${resolveJudgeUserContent(pair, ctxFacts)}`);
      }
      if (pairs.length === 0) return null;
      this.logger.log(`harness work taken ${companyId}: fact_conflict pairs=${pairs.length}`);
      return this.issue({
        kind: 'fact_conflict',
        companyId,
        userId: opts.userId,
        pairs,
        systemPrompt: batchInstructions('pair', 'p') + RESOLVE_JUDGE_SYSTEM,
        userContent: blocks.join('\n\n'),
        verdicts: RESOLVE_VERDICTS,
      });
    });
  }

  /**
   * Corroboration (0051): two active facts on one subject and predicate
   * that may be one assertion worded twice. Exact matches the nightly pass
   * applies itself; the paraphrases it defers in harness mode come here.
   */
  async takeFactCorroboration(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (!this.corroborate.configured()) return null;
    const max = batchSize(opts.max);
    const pin = await this.pin(companyId);
    return this.surreal.withCompany(companyId, async (db) => {
      const { groups } = await this.corroborate.findCandidateGroups(db, pin);
      const memo = await loadPairMemo(db, 'corroborate');
      const pairs: Array<[string, string, string]> = [];
      const blocks: string[] = [];
      for (const group of groups) {
        if (pairs.length >= max) break;
        if (group.scope !== (opts.userId ?? '')) continue;
        const members = await this.corroborate.fetchGroupMembers(db, group, pin);
        for (const pair of this.corroborate.selectPairs(members)) {
          if (pairs.length >= max) break;
          if (pair.younger.object.trim() === pair.incumbent.object.trim()) continue;
          const signature = pairSignature(pair.incumbent.object, pair.younger.object);
          const pairKey = `${String(pair.incumbent.id)}|${String(pair.younger.id)}`;
          if (alreadyJudged(memo, { pairKey, signature })) continue;
          pairs.push([String(pair.incumbent.id), String(pair.younger.id), signature]);
          blocks.push(`Pair p${pairs.length}:\n${corroborateUserContent(pair)}`);
        }
      }
      if (pairs.length === 0) return null;
      this.logger.log(`harness work taken ${companyId}: fact_corroboration pairs=${pairs.length}`);
      return this.issue({
        kind: 'fact_corroboration',
        companyId,
        userId: opts.userId,
        pairs,
        systemPrompt: batchInstructions('pair', 'p') + CORROBORATE_JUDGE_SYSTEM,
        userContent: blocks.join('\n\n'),
        verdicts: CORROBORATE_VERDICTS,
      });
    });
  }

  async submit(
    companyId: string,
    payload: PairsTokenPayload,
    result: unknown,
  ): Promise<PairsSubmitOutcome> {
    const verdicts = parseVerdicts(
      result,
      payload.t === 'entity_match'
        ? ENTITY_VERDICTS
        : payload.t === 'fact_conflict'
          ? RESOLVE_VERDICTS
          : CORROBORATE_VERDICTS,
    );
    const pin = payload.t === 'fact_conflict' ? await this.pin(companyId) : null;
    const out: PairsSubmitOutcome = {
      pairs: payload.p.length,
      applied: 0,
      unsure: 0,
      stale: 0,
      missing: 0,
    };
    await this.surreal.withCompany(companyId, async (db) => {
      for (const [i, [a, b, signature]] of payload.p.entries()) {
        const verdict = verdicts.get(`p${i + 1}`);
        if (!verdict) {
          out.missing += 1;
          continue;
        }
        const applied =
          payload.t === 'entity_match'
            ? await this.applyEntityVerdict(db, { a, b, signature, userId: payload.u }, verdict)
            : payload.t === 'fact_conflict'
              ? await this.applyConflictVerdict(db, { a, b, signature, pin }, verdict)
              : await this.applyCorroborationVerdict(db, { a, b, signature }, verdict);
        if (applied === 'stale') out.stale += 1;
        else if (verdict === 'unsure' || verdict === 'different') out.unsure += 1;
        else out.applied += 1;
      }
    });
    this.logger.log(
      `harness work submitted ${companyId}: ${payload.t} pairs=${out.pairs} applied=${out.applied} unsure=${out.unsure} stale=${out.stale}`,
    );
    return out;
  }

  /** The dedup pass's own write for a verdict, if the evidence still matches. */
  private async applyEntityVerdict(
    db: Surreal,
    p: { a: string; b: string; signature: string; userId: string | undefined },
    verdict: string,
  ): Promise<'ok' | 'stale'> {
    if (await this.dedup.identityEdgeExists(db, p.a, p.b)) return 'stale';
    const evidence = await this.entityEvidence(db, { aId: p.a, bId: p.b, userId: p.userId });
    if (!evidence || evidence.signature !== p.signature) return 'stale';
    if (verdict === 'same') {
      await this.dedup.linkIdentity(db, p.a, p.b);
    } else {
      await recordPairVerdict(db, {
        kind: 'dedup',
        pairKey: `${p.a}|${p.b}`,
        signature: p.signature,
        verdict,
      });
    }
    return 'ok';
  }

  /** The resolve pass's own write for a verdict, if both facts still compete on the same evidence. */
  private async applyConflictVerdict(
    db: Surreal,
    p: { a: string; b: string; signature: string; pin: string | null },
    verdict: string,
  ): Promise<'ok' | 'stale'> {
    const [rows] = await db.query<[CompetingFactRow[]]>(
      `SELECT id, entityId, predicate, object, confidence, validFrom, recordedAt, source, userId
         FROM [$a, $b] WHERE status = 'competing' AND retractedAt IS NONE`,
      { a: new StringRecordId(p.a), b: new StringRecordId(p.b) },
    );
    const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (!a || !b) return 'stale';
    const ctxFacts = await this.conflictContext(db, a, p.pin);
    if (pairSignature(a.object, b.object, ctxFacts) !== p.signature) return 'stale';
    if (verdict === 'unsure') {
      await recordPairVerdict(db, {
        kind: 'resolve',
        pairKey: `${p.a}|${p.b}`,
        signature: p.signature,
        verdict,
      });
    } else {
      const [winner, loser] = verdict === 'a_wins' ? [p.a, p.b] : [p.b, p.a];
      await this.resolver.markSuperseded(db, loser, winner);
    }
    return 'ok';
  }

  /** The corroborate pass's own write for a verdict, if both facts still stand as asked. */
  private async applyCorroborationVerdict(
    db: Surreal,
    p: { a: string; b: string; signature: string },
    verdict: string,
  ): Promise<'ok' | 'stale'> {
    const [rows] = await db.query<[ActiveFactRow[]]>(
      `SELECT id, entityId, predicate, object, validFrom, validUntil, recordedAt
         FROM [$a, $b] WHERE status = 'active' AND retractedAt IS NONE`,
      { a: new StringRecordId(p.a), b: new StringRecordId(p.b) },
    );
    const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
    const incumbent = byId.get(p.a);
    const younger = byId.get(p.b);
    if (!incumbent || !younger) return 'stale';
    if (pairSignature(incumbent.object, younger.object) !== p.signature) return 'stale';
    if (verdict === 'same_assertion') {
      await this.corroborate.applyCorroboration(db, { incumbent, younger });
    } else {
      await recordPairVerdict(db, {
        kind: 'corroborate',
        pairKey: `${p.a}|${p.b}`,
        signature: p.signature,
        verdict,
      });
    }
    return 'ok';
  }

  /**
   * Both sides' facts as the caller may read them, and the signature the
   * memo keys on. null when the caller can read nothing about either.
   */
  private async entityEvidence(
    db: Surreal,
    { aId, bId, userId }: { aId: string; bId: string; userId: string | undefined },
  ): Promise<{ a: string; b: string; signature: string } | null> {
    const a = await this.judge.fetchTopFacts(db, aId, { userId });
    const b = await this.judge.fetchTopFacts(db, bId, { userId });
    if (a === NO_FACTS && b === NO_FACTS) return null;
    return { a, b, signature: pairSignature(a, b) };
  }

  private conflictContext(db: Surreal, a: CompetingFactRow, pin: string | null): Promise<string> {
    return this.resolver.fetchEntityContext(
      db,
      { entityId: String(a.entityId), userId: a.userId ?? undefined },
      pin,
    );
  }

  private async names(db: Surreal, ids: string[]): Promise<Map<string, string>> {
    const [rows] = await db.query<[Array<{ id: unknown; canonicalName: string }>]>(
      `SELECT id, canonicalName FROM $ids`,
      { ids: ids.map((id) => new StringRecordId(id)) },
    );
    return new Map((rows ?? []).map((r) => [String(r.id), r.canonicalName]));
  }

  /** The live derived world, as the nightly pass fences it. */
  private async pin(companyId: string): Promise<string | null> {
    return (await this.readPin?.resolve(companyId)) ?? ReadPinService.bootstrapDefault();
  }

  private issue(p: {
    kind: 'entity_match' | 'fact_conflict' | 'fact_corroboration';
    companyId: string;
    userId: string | undefined;
    pairs: Array<[string, string, string]>;
    systemPrompt: string;
    userContent: string;
    verdicts: readonly string[];
  }): HarnessWork {
    const exp = workExpiry();
    const payload: PairsTokenPayload = {
      v: 2,
      t: p.kind,
      c: p.companyId,
      ...(p.userId !== undefined ? { u: p.userId } : {}),
      p: p.pairs,
      n: workNonce(),
      exp,
    };
    return {
      kind: p.kind,
      token: mintWorkToken(payload),
      systemPrompt: p.systemPrompt,
      userContent: p.userContent,
      schema: verdictSchema(p.verdicts),
      items: p.pairs.length,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}

/** What fetchTopFacts renders for an entity with nothing readable. */
const NO_FACTS = '(no facts)';

function batchSize(max: number | undefined): number {
  return Math.max(1, Math.min(max ?? PAIRS_PER_BATCH, PAIRS_PER_BATCH * 3));
}

function verdictSchema(verdicts: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pair: { type: 'string', description: 'The pair number, "p1", "p2", …' },
            verdict: { type: 'string', enum: [...verdicts] },
          },
          required: ['pair', 'verdict'],
        },
      },
    },
    required: ['verdicts'],
  };
}

/** `{verdicts: [{pair, verdict}]}` → pair → verdict; an unknown verdict is dropped. */
export function parseVerdicts(result: unknown, allowed: readonly string[]): Map<string, string> {
  const list = (result as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) {
    throw new BadRequestException('result.verdicts must be an array of {pair, verdict}');
  }
  const out = new Map<string, string>();
  for (const v of list as Array<{ pair?: unknown; verdict?: unknown }>) {
    if (typeof v?.pair !== 'string' || typeof v.verdict !== 'string') continue;
    const pair = v.pair
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    if (!allowed.includes(v.verdict) || out.has(pair)) continue;
    out.set(pair, v.verdict);
  }
  return out;
}
