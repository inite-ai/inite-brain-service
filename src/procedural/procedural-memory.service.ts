import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SurrealService, queryRows, queryFirst } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';

/**
 * ProceduralMemoryService — third tier alongside facts (semantic) and
 * episodes (timeline). Stores "how to" patterns that should trigger
 * when a matching context appears.
 *
 *   trigger  = "user asks about pricing"
 *   action   = "mention they're on platinum tier; they get 20% off"
 *
 * v1 surface:
 *   - record(trigger, action, priority?, decayHalfLifeDays?) — write
 *   - match(query, limit?, minSimilarity?) — cosine search over
 *     trigger embeddings, sorted by similarity DESC, priority ASC tie-
 *     break, retired procedures excluded.
 *   - list(limit?, includeRetired?) — admin paginated listing
 *   - retire(procedureId) — soft-delete; sets retiredAt.
 *
 * Decay is intentionally not yet applied at read time — the
 * decayHalfLifeDays field is a write-only hook for v0.2.
 *
 * No SubgraphRAG / search_multi_hop integration yet; the brief
 * called it a separate enhancement.
 */
@Injectable()
export class ProceduralMemoryService {
  private readonly logger = new Logger(ProceduralMemoryService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async record(companyId: string, args: RecordProcedureArgs): Promise<ProcedureRecord> {
    return this.surreal.withCompany(companyId, async (db) => {
      const embedding = await this.embedder.embed(args.trigger);

      const [row] = await db.query<[ProcedureRowDb]>(
        `CREATE ONLY procedural_memory CONTENT {
            trigger: $trigger,
            triggerEmbedding: $embedding,
            action: $action,
            priority: $priority,
            decayHalfLifeDays: $decayHalfLifeDays,
            source: $source,
            createdAt: time::now()
         }`,
        {
          trigger: args.trigger,
          embedding,
          action: args.action,
          priority: args.priority ?? 100,
          decayHalfLifeDays: args.decayHalfLifeDays,
          source: args.source ?? { kind: 'operator' },
        },
      );
      const created = row ?? null;
      if (!created) throw new Error('procedural_memory CREATE returned nothing');

      this.logger.log(
        `[procedural.recorded] companyId=${companyId} id=${String(created.id)} priority=${String(created.priority)}`,
      );

      return mapRow(created);
    });
  }

  /**
   * Match procedures whose trigger is cosine-similar to the input
   * query. Top-K results, sorted by similarity DESC then priority ASC
   * (lower priority number wins ties — convention is 100=normal,
   * 0=urgent).
   */
  async match(companyId: string, args: MatchProcedureArgs): Promise<MatchedProcedure[]> {
    // Caller-facing reads ride the scoped pool when the caller identifies
    // itself (MCP path). NOTE (R4 audit): the DB-level PERMISSIONS fence
    // does NOT fire for the system `brain_caller` user; access here is
    // gated at the tool/action level (see below), not by DB PERMISSIONS.
    //
    // No ABAC row-filter here by design: procedures are a curated
    // OPERATOR layer (trigger→action how-tos), not user facts — they
    // carry no predicate/piiClass and no per-user PII, so the fact-shaped
    // row engine doesn't map. Access is gated at the tool/action level
    // (@PolicyAction on the MCP procedural tools) instead.
    return this.run(companyId, args.callerScopes, async (db) => {
      const queryEmbedding = await this.embedder.embed(args.query);

      // Read all unretired procedures. With small N (procedural memory
      // is by design a curated layer, not a fact firehose) the JS-side
      // cosine pass is cheap; if a tenant goes past a few thousand
      // rows we revisit and push it into SurrealDB's vector::similarity
      // call. Doing it server-side today would require maintaining a
      // dimension-pinned vector index, which the embedder can swap at
      // runtime.
      const rows = await queryRows<ProcedureRowDb>(
        db,
        `SELECT id, trigger, triggerEmbedding, action, priority,
                decayHalfLifeDays, source, createdAt
           FROM procedural_memory
           WHERE retiredAt IS NONE
           ORDER BY priority ASC`,
      );

      const qNorm = vectorNorm(queryEmbedding);
      const minSim = args.minSimilarity ?? 0.4;
      const limit = args.limit ?? 5;

      const scored: MatchedProcedure[] = [];
      for (const p of rows) {
        const emb = Array.isArray(p.triggerEmbedding) ? (p.triggerEmbedding as number[]) : null;
        if (!emb) continue;
        const sim = cosineSimilarity(queryEmbedding, emb, qNorm);
        if (sim < minSim) continue;
        scored.push({
          ...mapRow(p),
          similarity: sim,
        });
      }
      scored.sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        return a.priority - b.priority;
      });
      return scored.slice(0, limit);
    });
  }

  async list(companyId: string, args: ListProceduresArgs = {}): Promise<ProcedureRecord[]> {
    return this.run(companyId, args.callerScopes, async (db) => {
      const filter = args.includeRetired ? '' : 'WHERE retiredAt IS NONE';
      const rows = await queryRows<ProcedureRowDb>(
        db,
        `SELECT id, trigger, action, priority, decayHalfLifeDays,
                source, createdAt, retiredAt
           FROM procedural_memory
           ${filter}
           ORDER BY priority ASC, createdAt DESC
           LIMIT $limit`,
        { limit: args.limit ?? 50 },
      );
      return rows.map(mapRow);
    });
  }

  private run<T>(
    companyId: string,
    callerScopes: readonly string[] | undefined,
    fn: Parameters<SurrealService['withCompany']>[1],
  ): Promise<T> {
    return (
      callerScopes
        ? this.surreal.withScopedCompany(companyId, callerScopes, fn)
        : this.surreal.withCompany(companyId, fn)
    ) as Promise<T>;
  }

  async retire(
    companyId: string,
    procedureIdRaw: string,
  ): Promise<{ procedureId: string; retiredAt: string }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const tail = procedureIdRaw.startsWith('procedural_memory:')
        ? procedureIdRaw.slice('procedural_memory:'.length)
        : procedureIdRaw;
      const updated = await queryFirst<ProcedureRowDb>(
        db,
        `UPDATE type::record('procedural_memory', $tail)
           SET retiredAt = time::now()
           WHERE retiredAt IS NONE
           RETURN AFTER`,
        { tail },
      );
      if (!updated) {
        throw new NotFoundException(
          `Procedural memory ${procedureIdRaw} not found (or already retired)`,
        );
      }
      return {
        procedureId: String(updated.id),
        retiredAt: toIso(updated.retiredAt),
      };
    });
  }
}

// Columns the procedural_memory SELECTs return. Every value funnels
// through String()/typeof/toIso in mapRow, so `unknown` is the honest
// type; triggerEmbedding is present only on the match() SELECT.
interface ProcedureRowDb {
  id: unknown;
  trigger?: unknown;
  action?: unknown;
  priority?: unknown;
  decayHalfLifeDays?: unknown;
  source?: unknown;
  createdAt?: unknown;
  retiredAt?: unknown;
  triggerEmbedding?: unknown;
}

function mapRow(row: ProcedureRowDb): ProcedureRecord {
  return {
    procedureId: String(row.id),
    trigger: String(row.trigger ?? ''),
    action: String(row.action ?? ''),
    priority: typeof row.priority === 'number' ? row.priority : 100,
    decayHalfLifeDays:
      typeof row.decayHalfLifeDays === 'number' ? row.decayHalfLifeDays : undefined,
    source: (row.source ?? { kind: 'operator' }) as Record<string, unknown>,
    createdAt: toIso(row.createdAt),
    retiredAt: row.retiredAt ? toIso(row.retiredAt) : undefined,
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  // SurrealDB v2.x ships native datetime as a tagged object. The
  // JS driver exposes a `toDate()` method on it; falling back to
  // String(v) covers ISO-string-like cases that slip through.
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  if (v) return String(v);
  return '';
}

function vectorNorm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosineSimilarity(a: number[], b: number[], aNorm: number): number {
  if (a.length !== b.length || aNorm === 0) return 0;
  let dot = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    // a.length === b.length (checked above) ⇒ both indices are in-bounds.
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    bNorm += bi * bi;
  }
  bNorm = Math.sqrt(bNorm);
  if (bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}

export interface RecordProcedureArgs {
  trigger: string;
  action: string;
  priority?: number;
  decayHalfLifeDays?: number;
  source?: Record<string, unknown>;
}

export interface MatchProcedureArgs {
  query: string;
  limit?: number;
  minSimilarity?: number;
  callerScopes?: readonly string[];
}

export interface ListProceduresArgs {
  limit?: number;
  includeRetired?: boolean;
  callerScopes?: readonly string[];
}

export interface ProcedureRecord {
  procedureId: string;
  trigger: string;
  action: string;
  priority: number;
  decayHalfLifeDays?: number | undefined;
  source: Record<string, unknown>;
  createdAt: string;
  retiredAt?: string | undefined;
}

export interface MatchedProcedure extends ProcedureRecord {
  similarity: number;
}
