import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StringRecordId, type Surreal } from 'surrealdb';
import OpenAI from 'openai';
import {
  chatCallParams,
  chatModel,
  createOpenAiClient,
  offlineServiceTier,
} from '../ai/openai-client';
import { withGenAiCall } from '../common/gen-ai-observability';
import { serverModelsRefused } from '../common/extraction-source';
import { isoString } from '../common/surreal-date';
import { supportEdgesEnabled } from '../common/provenance-flags';
import { buildConflictEdgeRows } from '../common/support-edges';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type ResolutionTokenPayload } from '../common/harness-work-token';
import { SurrealService } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { DreamsResolverService } from './resolver.service';
import { DreamsCorroborateService } from './corroborate.service';
import { pairSignature } from './pair-memo';
import {
  FACT_RESOLUTION_SYSTEM,
  RESOLUTION_CANDIDATES,
  RESOLUTION_FACTS_PER_BATCH,
  parseResolution,
  keepRecordSlots,
  resolutionActions,
  resolutionSchema,
  resolutionUserContent,
  type ResolutionAction,
  type ResolutionVerdict,
  type ResolvableFact,
} from './fact-resolution';
import {
  closeEdge,
  edgeCandidates,
  edgeResolvable,
  isEdgeId,
  pendingEdges,
  recordEdgeIds,
  reloadEdges,
  type OpenEdgeRow,
} from './edge-resolution';

/** An open fact as the pass reads it. */
interface OpenFactRow {
  id: unknown;
  entityId: unknown;
  entityName?: unknown;
  predicate: string;
  object: string;
  validFrom: unknown;
  validUntil?: unknown;
  recordedAt: unknown;
  userId?: unknown;
  scope?: unknown;
  embedding?: number[];
  source?: { episodeIds?: unknown; evidence?: unknown; recorder?: unknown; kind?: unknown } | null;
}

/** One new fact with the memory facts it is judged against. */
interface ResolutionItem {
  entity: string;
  fact: ResolvableFact;
  candidates: ResolvableFact[];
}

export interface ResolutionOutcome {
  facts: number;
  judged: number;
  superseded: number;
  corroborated: number;
  competing: number;
  /** Submitted for facts whose evidence changed since it was handed out. */
  stale: number;
}

const OPEN = `status IN ['active', 'competing'] AND retractedAt IS NONE`;

/**
 * Fact resolution (#828, fact-resolution.ts): each newly written open
 * fact is judged against the entity's open facts nearest to it in the
 * embedding space, and the verdicts are applied with the resolver's own
 * stamps — `markSuperseded` (the 0033 supersede shape), the 0051
 * corroboration write, and `competing`. Judged by the server's chat
 * model, or in harness mode by the connected agent (`fact_resolution`).
 * A fact with nothing to compare against is marked judged without a call.
 * New open edges go through the same pass (#834, edge-resolution.ts).
 */
@Injectable()
export class FactResolutionService {
  private readonly logger = new Logger(FactResolutionService.name);
  private readonly openai: OpenAI | undefined;
  private readonly model: string;

  // eslint-disable-next-line max-params -- Nest DI constructor; each param is an injection token
  constructor(
    private readonly surreal: SurrealService,
    private readonly resolver: DreamsResolverService,
    private readonly corroborate: DreamsCorroborateService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.openai = createOpenAiClient(config) ?? undefined;
    this.model = chatModel(config);
  }

  /**
   * Judge and apply the tenant's pending facts with the server's model,
   * in bounded batches. A no-op in harness mode — the agent takes the work.
   */
  async runPending(companyId: string, maxBatches = 4): Promise<ResolutionOutcome> {
    const out = emptyOutcome();
    if (serverModelsRefused() || !this.openai) return out;
    for (let i = 0; i < maxBatches; i++) {
      const items = await this.surreal.withCompany(companyId, (db) =>
        this.nextItems(db, { userId: undefined, anyScope: true }),
      );
      if (items.length === 0) break;
      const verdicts = await this.judge(items);
      await this.surreal.withCompany(companyId, async (db) => {
        for (const [i2, item] of items.entries()) {
          add(out, await this.apply(db, item, verdicts.get(i2) ?? new Map()));
        }
      });
    }
    if (out.facts > 0) {
      this.logger.log(
        `fact resolution ${companyId}: facts=${out.facts} judged=${out.judged} superseded=${out.superseded} corroborated=${out.corroborated} competing=${out.competing}`,
      );
    }
    return out;
  }

  /** Harness mode: the next batch of pending facts of one user scope, or null. */
  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    const items = await this.surreal.withCompany(companyId, (db) =>
      this.nextItems(db, { userId: opts.userId, anyScope: false, max: opts.max }),
    );
    if (items.length === 0) return null;
    const payload: ResolutionTokenPayload = {
      v: 2,
      t: 'fact_resolution',
      c: companyId,
      ...(opts.userId !== undefined ? { u: opts.userId } : {}),
      n: workNonce(),
      exp: workExpiry(),
      f: items.map((it) => [it.fact.id, it.candidates.map((c) => c.id), signatureOf(it)]),
    };
    this.logger.log(`harness work taken ${companyId}: fact_resolution facts=${items.length}`);
    return {
      kind: 'fact_resolution',
      token: mintWorkToken(payload),
      systemPrompt: batchInstructions('item', 'r') + FACT_RESOLUTION_SYSTEM,
      userContent: resolutionUserContent(items),
      schema: resolutionSchema(),
      items: items.length,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /** Harness mode: apply a verified token's reply; changed evidence is skipped as stale. */
  async submit(
    companyId: string,
    payload: ResolutionTokenPayload,
    result: unknown,
  ): Promise<ResolutionOutcome> {
    const verdicts = parseResolution(result);
    const out = emptyOutcome();
    await this.surreal.withCompany(companyId, async (db) => {
      for (const [i, [factId, candidateIds, signature]] of payload.f.entries()) {
        const item = await this.reload(db, factId, candidateIds);
        if (!item || signatureOf(item) !== signature) {
          out.stale += 1;
          continue;
        }
        add(out, await this.apply(db, item, verdicts.get(i) ?? new Map()));
      }
    });
    this.logger.log(
      `harness work submitted ${companyId}: fact_resolution facts=${out.facts} superseded=${out.superseded} corroborated=${out.corroborated} competing=${out.competing} stale=${out.stale}`,
    );
    return out;
  }

  /**
   * Pending open facts with their candidates, oldest first. One whose
   * entity holds nothing else open is marked judged here, without a call.
   */
  private async nextItems(
    db: Surreal,
    opts: { userId: string | undefined; anyScope: boolean; max?: number | undefined },
  ): Promise<ResolutionItem[]> {
    const want = Math.max(1, Math.min(opts.max ?? RESOLUTION_FACTS_PER_BATCH, 64));
    const scope = opts.anyScope ? '' : opts.userId ? 'AND userId = $u' : 'AND userId IS NONE';
    const items: ResolutionItem[] = [];
    // Facts already in this batch, as an item or a candidate: judging one
    // fact twice, or a fact another item's verdict may change, only
    // yields a stale reply — it waits for the next batch instead.
    const taken = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 4 && items.length < want; page++) {
      const [rows] = await db.query<[OpenFactRow[]]>(
        `SELECT id, entityId, entityId.canonicalName AS entityName, predicate, object,
                validFrom, validUntil, recordedAt, userId, scope, embedding, source
           FROM knowledge_fact
          WHERE resolutionCheckedAt IS NONE AND ${OPEN} AND derivedVersion IS NONE ${scope}
          ORDER BY recordedAt ASC LIMIT $k START $off`,
        { u: opts.userId, k: want * 2, off: offset },
      );
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        if (items.length >= want) break;
        const id = String(row.id);
        if (taken.has(id)) {
          offset += 1;
          continue;
        }
        const candidates = await this.candidates(db, row);
        if (candidates.length === 0) {
          await markChecked(db, id);
          continue;
        }
        offset += 1;
        taken.add(id);
        for (const c of candidates) taken.add(c.id);
        items.push({ entity: String(row.entityName ?? ''), fact: resolvable(row), candidates });
      }
    }
    if (items.length < want) await this.nextEdgeItems(db, opts, { items, taken, want });
    await this.attachSources(db, items);
    return items;
  }

  /**
   * Pending open edges (#834, edge-resolution.ts), after the facts: each
   * judged against the open edges sharing an endpoint with it. One with
   * nothing to compare against is marked judged without a call.
   */
  private async nextEdgeItems(
    db: Surreal,
    opts: { userId: string | undefined; anyScope: boolean },
    batch: { items: ResolutionItem[]; taken: Set<string>; want: number },
  ): Promise<void> {
    const scope = opts.anyScope ? '' : 'AND scopeKey = $u';
    let offset = 0;
    for (let page = 0; page < 4 && batch.items.length < batch.want; page++) {
      const rows = await pendingEdges(db, {
        scope,
        limit: batch.want * 2,
        offset,
        u: opts.userId ?? '',
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (batch.items.length >= batch.want) break;
        const id = String(row.id);
        if (batch.taken.has(id)) {
          offset += 1;
          continue;
        }
        const candidates = await edgeCandidates(db, row);
        if (candidates.length === 0) {
          await markChecked(db, id);
          continue;
        }
        offset += 1;
        batch.taken.add(id);
        for (const c of candidates) batch.taken.add(String(c.id));
        batch.items.push(await edgeItem(db, row, candidates));
      }
    }
  }

  /**
   * What each fact was read from, for the judge: the turn (clipped), or
   * for a direct write who recorded it and its evidence note. Telling a
   * later decision ("replaces") from two sources that disagree
   * ("contradicts") needs the sources — Graphiti's resolver reads the
   * episode beside the edge. A turn the fact names is read in this
   * tenant, the work's own user scope.
   */
  private async attachSources(db: Surreal, items: ResolutionItem[]): Promise<void> {
    const facts = items.flatMap((it) => [it.fact, ...it.candidates]);
    const eps = [...new Set(facts.flatMap((f) => (f.episodeId ? [f.episodeId] : [])))];
    const [rows] = eps.length
      ? await db.query<[Array<{ id: unknown; text?: unknown }>]>(`SELECT id, text FROM $ids`, {
          ids: eps.map((id) => new StringRecordId(id)),
        })
      : [[]];
    const text = new Map((rows ?? []).map((r) => [String(r.id), String(r.text ?? '')]));
    for (const f of facts) {
      const turn = f.episodeId ? text.get(f.episodeId) : undefined;
      if (turn) f.source = `"${clipSource(turn)}"`;
    }
  }

  /**
   * The entity's open facts nearest to `row`, nearest first, from the
   * pool fn::resolve_fact (0177) resolves in: the same user, the same
   * circle and team tags, the live world. A fact said in one circle is never
   * judged against — nor can it close — another circle's.
   */
  private async candidates(db: Surreal, row: OpenFactRow): Promise<ResolvableFact[]> {
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) return [];
    const userGate = row.userId ? 'userId = $u' : 'userId IS NONE';
    const circles = (Array.isArray(row.scope) ? row.scope.map(String) : [])
      .filter((t) => t.startsWith('circle:') || t.startsWith('team:'))
      .sort();
    const [rows] = await db.query<[OpenFactRow[]]>(
      `SELECT id, predicate, object, validFrom, validUntil, recordedAt, source,
              vector::similarity::cosine(embedding, $v) AS sim
         FROM knowledge_fact
        WHERE entityId = $e AND id != $id AND ${OPEN} AND ${userGate}
          AND derivedVersion IS NONE
          AND array::sort((scope ?? []).filter(|$t| string::starts_with($t, 'circle:') OR string::starts_with($t, 'team:'))) = $circles
          AND embedding != NONE AND array::len(embedding) = array::len($v)
        ORDER BY sim DESC LIMIT $k`,
      {
        e: row.entityId,
        id: row.id,
        u: row.userId,
        v: row.embedding,
        k: RESOLUTION_CANDIDATES,
        circles,
      },
    );
    return (rows ?? []).map(resolvable);
  }

  /** A token's item as it stands now; null when the fact is no longer open. */
  private async reload(
    db: Surreal,
    factId: string,
    candidateIds: string[],
  ): Promise<ResolutionItem | null> {
    if (isEdgeId(factId)) {
      const rows = await reloadEdges(db, [factId, ...candidateIds]);
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const edge = byId.get(factId);
      if (!edge) return null;
      return edgeItem(
        db,
        edge,
        candidateIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      );
    }
    const [rows] = await db.query<[OpenFactRow[]]>(
      `SELECT id, entityId.canonicalName AS entityName, predicate, object, validFrom, validUntil,
              recordedAt, source FROM $ids WHERE ${OPEN}`,
      { ids: [factId, ...candidateIds].map((id) => new StringRecordId(id)) },
    );
    const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
    const fact = byId.get(factId);
    if (!fact) return null;
    return {
      entity: String(fact.entityName ?? ''),
      fact: resolvable(fact),
      candidates: candidateIds.flatMap((id) => {
        const c = byId.get(id);
        return c ? [resolvable(c)] : [];
      }),
    };
  }

  /** Apply one item's verdicts and mark the fact judged. */
  private async apply(
    db: Surreal,
    item: ResolutionItem,
    verdicts: Map<number, ResolutionVerdict>,
  ): Promise<ResolutionOutcome> {
    const out = emptyOutcome();
    out.facts = 1;
    out.judged = verdicts.size > 0 ? 1 : 0;
    const records = new Set(
      [item.fact, ...item.candidates].filter((f) => f.ofRecord).map((f) => f.id),
    );
    const actions = keepRecordSlots(resolutionActions(item.fact, item.candidates, verdicts), (id) =>
      records.has(id),
    );
    if (isEdgeId(item.fact.id)) {
      // An edge carries no `competing` status and an identical edge is one
      // row already, so only `replaces` writes: the earlier relation closes
      // at the later one's start.
      const validFrom = new Map([item.fact, ...item.candidates].map((f) => [f.id, f.validFrom]));
      for (const action of actions) {
        if (action.kind !== 'supersede') continue;
        await closeEdge(db, action.loser, validFrom.get(action.winner)!);
        out.superseded += 1;
      }
      await markChecked(db, item.fact.id);
      return out;
    }
    for (const action of actions) {
      await this.write(db, action);
      await this.writeSupportEdges(db, action);
      if (action.kind === 'supersede') out.superseded += 1;
      else if (action.kind === 'corroborate') out.corroborated += 1;
      else out.competing += 1;
    }
    await markChecked(db, item.fact.id);
    return out;
  }

  /**
   * The typed support graph (PROVENANCE_SUPPORT_EDGES) records what the
   * write resolver used to record when it decided a conflict: a replaced
   * value `superseded_by` its successor, and both sides of a dispute
   * `contradicted_by` each other. Since #830 those decisions are made
   * here, so the edges are written here, through the same row builder.
   */
  private async writeSupportEdges(db: Surreal, action: ResolutionAction): Promise<void> {
    if (!supportEdgesEnabled()) return;
    const verdict =
      action.kind === 'supersede'
        ? { outcome: 'SUPERSEDED', factId: action.winner, supersededFactIds: [action.loser] }
        : action.kind === 'compete'
          ? { outcome: 'COMPETING', factId: action.a, competingFactIds: [action.b] }
          : action.kind === 'dispute'
            ? { outcome: 'COMPETING', factId: action.claim, competingFactIds: [action.record] }
            : null;
    if (!verdict) return;
    const rows = buildConflictEdgeRows(verdict, 2);
    if (rows.length === 0) return;
    try {
      await db.query(`INSERT RELATION IGNORE INTO memory_support $rows`, {
        rows: rows.map((r) => ({
          ...r,
          in: new StringRecordId(r.in),
          out: new StringRecordId(r.out),
        })),
      });
    } catch (e) {
      this.logger.warn(`resolution support-edge write failed (non-fatal): ${(e as Error).message}`);
    }
  }

  private async write(db: Surreal, action: ResolutionAction): Promise<void> {
    switch (action.kind) {
      case 'supersede':
        // A winner that was competing against the loser becomes active
        // through the 0175 event (and stays competing if it has another
        // rival).
        await this.resolver.markSuperseded(db, action.loser, action.winner);
        return;
      case 'corroborate':
        await this.corroborate.applyCorroboration(db, {
          incumbent: { id: action.incumbent } as never,
          younger: { id: action.younger } as never,
        });
        return;
      case 'dispute':
        // The claim competes beside the record value, linked to it so it
        // keeps a rival (fn::fact_has_rival); the record is not touched.
        await db.query(
          `IF array::len(SELECT VALUE id FROM [$claim, $record] WHERE ${OPEN}) = 2 {
             UPDATE $claim SET
               status = 'competing',
               conflictTrace.competingFactIds =
                 array::union(conflictTrace.competingFactIds ?? [], [$record]);
           };`,
          { claim: new StringRecordId(action.claim), record: new StringRecordId(action.record) },
        );
        return;
      case 'compete': {
        // Both must still be open — a lone competing row is what 0175
        // forbids. Each side names the other: two facts that contradict
        // across predicate names share no slot, and the link is what keeps
        // them rivals (fn::fact_has_rival).
        const [a, b] = [action.a, action.b].map((id) => new StringRecordId(id));
        await db.query(
          `IF array::len(SELECT VALUE id FROM [$a, $b] WHERE ${OPEN}) = 2 {
             FOR $pair IN [[$a, $b], [$b, $a]] {
               UPDATE $pair[0] SET
                 status = 'competing',
                 conflictTrace.competingFactIds =
                   array::union(conflictTrace.competingFactIds ?? [], [$pair[1]]);
             };
           };`,
          { a, b },
        );
        return;
      }
    }
  }

  /** One model call for a batch; no answer → no verdicts (nothing changes). */
  private async judge(items: ResolutionItem[]): Promise<ReturnType<typeof parseResolution>> {
    try {
      const res = await withGenAiCall(
        {
          kind: 'chat',
          spanName: 'gen_ai.chat.fact_resolution',
          system: 'openai',
          model: this.model,
        },
        this.metrics,
        () =>
          this.openai!.chat.completions.create({
            model: this.model,
            messages: [
              {
                role: 'system',
                content: batchInstructions('item', 'r') + FACT_RESOLUTION_SYSTEM,
              },
              { role: 'user', content: resolutionUserContent(items) },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'fact_resolution', strict: true, schema: resolutionSchema() },
            },
            ...chatCallParams(this.model, {
              tier: offlineServiceTier(),
              temperature: 0,
              visibleCap: 64 * items.length * RESOLUTION_CANDIDATES,
              reasoningEffort: 'none',
            }),
          }),
      );
      const content = res.choices[0]?.message?.content;
      return content ? parseResolution(JSON.parse(content)) : new Map();
    } catch (e) {
      this.logger.warn(`fact resolution judge failed: ${(e as Error).message}`);
      return new Map();
    }
  }
}

/** An edge and its candidates as one judged item, under the edge subject's name. */
async function edgeItem(
  db: Surreal,
  edge: OpenEdgeRow,
  candidates: OpenEdgeRow[],
): Promise<ResolutionItem> {
  const records = await recordEdgeIds(db, [edge, ...candidates]);
  const of = (r: OpenEdgeRow) => edgeResolvable(r, records.has(String(r.id)));
  return { entity: String(edge.fromName ?? ''), fact: of(edge), candidates: candidates.map(of) };
}

function resolvable(row: OpenFactRow): ResolvableFact {
  const until = row.validUntil ? isoString(row.validUntil) : '';
  const eps = Array.isArray(row.source?.episodeIds) ? row.source.episodeIds.map(String) : [];
  const note = Array.isArray(row.source?.evidence)
    ? (row.source.evidence as Array<{ note?: unknown }>)
        .map((e) => (typeof e?.note === 'string' ? e.note : ''))
        .filter(Boolean)
        .join('; ')
    : '';
  const recorder = typeof row.source?.recorder === 'string' ? row.source.recorder : '';
  // Until the turn is attached (attachSources), a direct write says who wrote it.
  const direct =
    !eps[0] && (recorder || note)
      ? `written by ${recorder || 'a caller'}${note ? ` (${note})` : ''}`
      : '';
  return {
    id: String(row.id),
    predicate: row.predicate,
    object: row.object,
    validFrom: isoString(row.validFrom),
    ...(until ? { validUntil: until } : {}),
    recordedAt: isoString(row.recordedAt),
    ...(eps[0] ? { episodeId: eps[0] } : {}),
    ...(direct ? { source: direct } : {}),
    ...(row.source?.kind === 'source_record' ? { ofRecord: true } : {}),
  };
}

/** Characters of a source turn shown to the judge (the extractor's earlier-turn clip). */
const SOURCE_CHARS = 280;

function clipSource(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > SOURCE_CHARS ? `${t.slice(0, SOURCE_CHARS - 1)}…` : t;
}

/** What the judge was shown for one item — a changed value or time makes a reply stale. */
function signatureOf(item: ResolutionItem): string {
  const part = (f: ResolvableFact) => [f.id, f.object, f.validFrom, f.validUntil ?? ''];
  return pairSignature(part(item.fact), item.candidates.map(part));
}

async function markChecked(db: Surreal, factId: string): Promise<void> {
  await db.query(`UPDATE $id SET resolutionCheckedAt = time::now()`, {
    id: new StringRecordId(factId),
  });
}

function emptyOutcome(): ResolutionOutcome {
  return { facts: 0, judged: 0, superseded: 0, corroborated: 0, competing: 0, stale: 0 };
}

function add(into: ResolutionOutcome, part: ResolutionOutcome): void {
  into.facts += part.facts;
  into.judged += part.judged;
  into.superseded += part.superseded;
  into.corroborated += part.corroborated;
  into.competing += part.competing;
  into.stale += part.stale;
}
