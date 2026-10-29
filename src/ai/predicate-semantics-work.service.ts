import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type PredicatesTokenPayload } from '../common/harness-work-token';
import { HARNESS_SEMANTICS_PENDING, PredicateRegistryService } from './predicate-registry.service';
import {
  PREDICATE_SEMANTICS_SYSTEM,
  predicateSemanticsUserContent,
} from './predicate-semantics-judge.service';

/** Predicates per batch: one name and one example each. */
export const PREDICATES_PER_BATCH = 20;

const SEMANTICS = ['single_active', 'append_only'] as const;

/** What a submitted batch of classifications did. */
export interface PredicatesSubmitOutcome {
  predicates: number;
  singleActive: number;
  appendOnly: number;
  /** Classified since (by an operator, or another take). */
  stale: number;
  missing: number;
}

/**
 * Harness mode (#819): the cardinality of a predicate coined by a writer
 * that did not state one (a direct fact, record_fact) — the question the
 * server's judge answers at proposal time. In harness mode the registry
 * files such a coinage append_only, the conservative default, marked
 * pending (HARNESS_SEMANTICS_PENDING); the connected agent classifies it
 * here with the judge's own prompt, and the registry's own update applies
 * it (cache invalidated, so the next fact under it is resolved by it).
 *
 * The vocabulary is the tenant's, shown to every extraction; the example
 * beside each name is one fact the caller itself may read, or none.
 */
@Injectable()
export class PredicateSemanticsWorkService {
  private readonly logger = new Logger(PredicateSemanticsWorkService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly registry: PredicateRegistryService,
  ) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    const max = Math.max(1, Math.min(opts.max ?? PREDICATES_PER_BATCH, PREDICATES_PER_BATCH));
    const pending = await this.pending(companyId, max);
    if (pending.length === 0) return null;
    const blocks: string[] = [];
    for (const [i, predicate] of pending.entries()) {
      const example = await this.example(companyId, predicate, opts.userId);
      blocks.push(
        `Predicate q${i + 1}:\n${predicateSemanticsUserContent(predicate, example ?? '(none)')}`,
      );
    }
    const exp = workExpiry();
    const payload: PredicatesTokenPayload = {
      v: 2,
      t: 'predicate_semantics',
      c: companyId,
      ...(opts.userId !== undefined ? { u: opts.userId } : {}),
      q: pending,
      n: workNonce(),
      exp,
    };
    this.logger.log(
      `harness work taken ${companyId}: predicate_semantics predicates=${pending.length}`,
    );
    return {
      kind: 'predicate_semantics',
      token: mintWorkToken(payload),
      systemPrompt: batchInstructions('predicate', 'q') + PREDICATE_SEMANTICS_SYSTEM,
      userContent: blocks.join('\n\n'),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          predicates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                predicate: { type: 'string', description: 'The predicate number, "q1", "q2", …' },
                semantics: { type: 'string', enum: [...SEMANTICS] },
              },
              required: ['predicate', 'semantics'],
            },
          },
        },
        required: ['predicates'],
      },
      items: pending.length,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async submit(
    companyId: string,
    payload: PredicatesTokenPayload,
    result: unknown,
  ): Promise<PredicatesSubmitOutcome> {
    const list = (result as { predicates?: unknown } | null)?.predicates;
    if (!Array.isArray(list)) {
      throw new BadRequestException('result.predicates must be an array of {predicate, semantics}');
    }
    const answers = new Map<string, (typeof SEMANTICS)[number]>();
    for (const a of list as Array<{ predicate?: unknown; semantics?: unknown }>) {
      if (typeof a?.predicate !== 'string') continue;
      const s = SEMANTICS.find((x) => x === a.semantics);
      const key = a.predicate.trim().toLowerCase();
      if (s && !answers.has(key)) answers.set(key, s);
    }
    const out: PredicatesSubmitOutcome = {
      predicates: payload.q.length,
      singleActive: 0,
      appendOnly: 0,
      stale: 0,
      missing: 0,
    };
    const stillPending = new Set(await this.pending(companyId, Number.MAX_SAFE_INTEGER));
    for (const [i, predicate] of payload.q.entries()) {
      const semantics = answers.get(`q${i + 1}`);
      if (!semantics) {
        out.missing += 1;
        continue;
      }
      if (!stillPending.has(predicate)) {
        out.stale += 1;
        continue;
      }
      const current = (await this.registry.listAll(companyId)).find(
        (p) => p.predicateId === predicate,
      );
      await this.registry.update(companyId, predicate, {
        semantics,
        description: (current?.description ?? '').replace(
          `${semanticsWord(current?.semantics)} by the ${HARNESS_SEMANTICS_PENDING}`,
          `${semantics} by the harness agent`,
        ),
      });
      if (semantics === 'single_active') out.singleActive += 1;
      else out.appendOnly += 1;
    }
    this.logger.log(
      `harness work submitted ${companyId}: predicate_semantics predicates=${out.predicates} single=${out.singleActive} stale=${out.stale}`,
    );
    return out;
  }

  /** Proposals the harness filed and no reader has classified yet, oldest first. */
  private async pending(companyId: string, limit: number): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ predicateId: string }>]>(
        `SELECT predicateId, createdAt FROM knowledge_predicate
          WHERE status = 'proposed' AND string::contains(description ?? '', $mark)
          ORDER BY createdAt ASC, predicateId ASC LIMIT $k`,
        { mark: `by the ${HARNESS_SEMANTICS_PENDING}`, k: Math.min(limit, 1000) },
      );
      return (rows ?? []).map((r) => r.predicateId);
    });
  }

  /** One `predicate: object` line the caller may read — the judge's "example use". */
  private async example(
    companyId: string,
    predicate: string,
    userId: string | undefined,
  ): Promise<string | undefined> {
    return this.surreal.withCompany(companyId, async (db) => {
      const gate = userId ? '(userId IS NONE OR userId = $u)' : 'userId IS NONE';
      const [rows] = await db.query<[Array<{ object: string }>]>(
        `SELECT object, recordedAt FROM knowledge_fact
          WHERE predicate = $p AND retractedAt IS NONE AND ${gate}
          ORDER BY recordedAt DESC LIMIT 1`,
        { p: predicate, u: userId },
      );
      const object = rows?.[0]?.object;
      return object === undefined ? undefined : `${predicate}: ${object}`;
    });
  }
}

function semanticsWord(s: string | undefined): string {
  return s ?? 'append_only';
}
