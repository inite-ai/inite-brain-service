import { Injectable, Logger, Optional } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { makeRowPolicyFilter } from '../policy/row-filter';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { renderUpdateStory, type PreviousValue } from './update-story';

interface LoserRow {
  id: unknown;
  predicate: string;
  supersededBy: unknown;
  object: string;
  validUntil?: Date | string;
  // Policy fields (audit 2026-08-19 P1) — see row-filter.ts.
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

/** Depth of the reverse-link walk: the immediate predecessor plus two
 *  earlier generations — matches the render cap. */
const MAX_STORY_DEPTH = 3;

/**
 * Update-story lane (V10 §2, profile.updateStoryRendering).
 *
 * For the evidence facts of one answer, batch-fetches their superseded
 * predecessors through the reverse supersededBy links (indexed since
 * 0059) and renders each fact's compact history suffix. One query per
 * chain generation (≤3), only when the profile opts in — a world
 * without supersedes pays one empty indexed lookup.
 *
 * Same contracts as the sibling lanes: PII gate for callers without
 * brain:read_pii, fail-closed user scope, degrade to an empty map on
 * any failure, no env reads. No derived-version gate: supersede links
 * are namespace-local by the resolver contract (0079), so a pinned
 * winner only ever links to rows of its own world.
 */
@Injectable()
export class UpdateStoryService {
  private readonly logger = new Logger(UpdateStoryService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional()
    private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  /** factId → rendered history suffix, for facts that have history. */
  async previousStories(opts: {
    companyId: string;
    factIds: string[];
    callerScopes: string[];
    /** Scope key of the asking end-user; omitted → tenant-global only. */
    userId?: string | undefined;
  }): Promise<Map<string, string>> {
    if (opts.factIds.length === 0) return new Map();
    const piiGate = opts.callerScopes.includes('brain:read_pii') ? '' : 'AND piiClass IS NONE';
    const userGate = opts.userId
      ? 'AND (userId IS NONE OR userId = $scopeUserId)'
      : 'AND userId IS NONE';
    const userParams = opts.userId ? { scopeUserId: opts.userId } : {};
    try {
      // Predicate scope-fence + ABAC row verdict (audit 2026-08-13 P0):
      // a superseded ancestor may carry a DIFFERENT predicate than the
      // already-policy-filtered winner (slot arbitration is cosine-,
      // not predicate-keyed), so its history line gets its own check.
      const rowPolicy = makeRowPolicyFilter({
        callerScopes: opts.callerScopes,
        surface: 'update_story',
        policyLookup: await this.predicateRegistry?.rowPolicyLookup(opts.companyId),
      });
      const perRoot = new Map<string, PreviousValue[]>();
      await this.surreal.withCompany(opts.companyId, async (db) => {
        // currentId → the evidence fact whose story it belongs to.
        let frontier = new Map<string, string>(opts.factIds.map((id) => [id, id]));
        for (let depth = 0; depth < MAX_STORY_DEPTH; depth += 1) {
          if (frontier.size === 0) break;
          const res = await db.query<[unknown, LoserRow[]]>(
            `LET $w = $winners.map(|$x| type::record($x));
             SELECT id, predicate, supersededBy, object, validUntil,
                    source, trustSnapshot, corroboration, userId
               FROM knowledge_fact
              WHERE supersededBy IN $w
                AND status = 'superseded'
                AND retractedAt IS NONE
                ${piiGate} ${userGate}
              ORDER BY validUntil DESC`,
            { winners: [...frontier.keys()], ...userParams },
          );
          const rows = ((res[1] ?? []) as LoserRow[]).filter((r) => rowPolicy.filter(r));
          const next = new Map<string, string>();
          for (const row of rows) {
            const root = frontier.get(String(row.supersededBy));
            if (!root) continue;
            const list = perRoot.get(root) ?? [];
            list.push({
              object: row.object,
              validUntil: row.validUntil === undefined ? undefined : String(row.validUntil),
            });
            perRoot.set(root, list);
            next.set(String(row.id), root);
          }
          frontier = next;
        }
      });
      rowPolicy.finish();
      const out = new Map<string, string>();
      for (const [factId, prevs] of perRoot) {
        const suffix = renderUpdateStory(prevs);
        if (suffix) out.set(factId, suffix);
      }
      return out;
    } catch (e) {
      this.logger.warn(
        `update-story fetch failed (companyId=${opts.companyId}): ${(e as Error).message}`,
      );
      return new Map();
    }
  }
}
