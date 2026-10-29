import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { batchInstructions, workExpiry, workNonce, type HarnessWork } from '../common/harness-work';
import { mintWorkToken, type BeliefsTokenPayload } from '../common/harness-work-token';
import { pairSignature } from '../dreams/pair-memo';
import { sceneBeliefLlmSynthesisEnabled } from '../common/scene-flags';
import {
  beliefStatementRequest,
  cleanBeliefStatement,
  type BeliefStatementInput,
} from './belief-statement';

/** Beliefs per batch: a line or two each. */
export const BELIEFS_PER_BATCH = 20;

/** What a submitted batch of statements did. */
export interface BeliefsSubmitOutcome {
  beliefs: number;
  phrased: number;
  /** Revised, superseded or phrased since the batch was taken. */
  stale: number;
  missing: number;
}

interface BeliefRow extends BeliefStatementInput {
  id: unknown;
  priorValue: string;
}

/**
 * Harness mode (#819): belief statements (SCENES_BELIEF_LLM_SYNTHESIS) —
 * a promoted (subject, attribute, value) phrased as one sentence. The
 * promotion pass stores the deterministic template in harness mode
 * (statementSource 'template'); the connected agent phrases those here
 * with the pass's own prompt, and the sentence replaces the template on
 * the same revision only while that revision still states what it was
 * asked about. Beliefs are single-user by construction (0120): a user's
 * caller phrases that user's beliefs; a tenant-global caller has none.
 */
@Injectable()
export class BeliefStatementWorkService {
  private readonly logger = new Logger(BeliefStatementWorkService.name);

  constructor(private readonly surreal: SurrealService) {}

  async take(
    companyId: string,
    opts: { userId?: string | undefined; max?: number | undefined } = {},
  ): Promise<HarnessWork | null> {
    if (!sceneBeliefLlmSynthesisEnabled() || opts.userId === undefined) return null;
    const max = Math.max(1, Math.min(opts.max ?? BELIEFS_PER_BATCH, BELIEFS_PER_BATCH));
    const rows = await this.pending(companyId, opts.userId, max);
    if (rows.length === 0) return null;
    const requests = rows.map((r) => beliefStatementRequest(r));
    // The system prompt carries the negation clause when any belief in the
    // batch needs it; the clause only ever explains the sentinel value.
    const system = requests.reduce(
      (longest, r) => (r.system.length > longest.length ? r.system : longest),
      requests[0]!.system,
    );
    const exp = workExpiry();
    const payload: BeliefsTokenPayload = {
      v: 2,
      t: 'belief_statement',
      c: companyId,
      u: opts.userId,
      b: rows.map((r) => [String(r.id), signatureOf(r)]),
      n: workNonce(),
      exp,
    };
    this.logger.log(`harness work taken ${companyId}: belief_statement beliefs=${rows.length}`);
    return {
      kind: 'belief_statement',
      token: mintWorkToken(payload),
      systemPrompt: batchInstructions('belief', 'b') + system,
      userContent: requests.map((r, i) => `Belief b${i + 1}:\n${r.user}`).join('\n\n'),
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          beliefs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                belief: { type: 'string', description: 'The belief number, "b1", "b2", …' },
                statement: { type: 'string' },
              },
              required: ['belief', 'statement'],
            },
          },
        },
        required: ['beliefs'],
      },
      items: rows.length,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async submit(
    companyId: string,
    payload: BeliefsTokenPayload,
    result: unknown,
  ): Promise<BeliefsSubmitOutcome> {
    const list = (result as { beliefs?: unknown } | null)?.beliefs;
    if (!Array.isArray(list)) {
      throw new BadRequestException('result.beliefs must be an array of {belief, statement}');
    }
    const statements = new Map<string, string>();
    for (const a of list as Array<{ belief?: unknown; statement?: unknown }>) {
      if (typeof a?.belief !== 'string') continue;
      const text = cleanBeliefStatement(a.statement);
      const key = a.belief.trim().toLowerCase();
      if (text !== null && !statements.has(key)) statements.set(key, text);
    }
    const out: BeliefsSubmitOutcome = {
      beliefs: payload.b.length,
      phrased: 0,
      stale: 0,
      missing: 0,
    };
    await this.surreal.withCompany(companyId, async (db) => {
      for (const [i, [id, signature]] of payload.b.entries()) {
        const text = statements.get(`b${i + 1}`);
        if (!text) {
          out.missing += 1;
          continue;
        }
        const [rows] = await db.query<[BeliefRow[]]>(
          `SELECT id, subject, field, value, priorValue ?? '' AS priorValue FROM $id
            WHERE status = 'active' AND statementSource = 'template' AND userId = $u`,
          { id: new StringRecordId(id), u: payload.u },
        );
        const row = rows?.[0];
        if (!row || signatureOf(row) !== signature) {
          out.stale += 1;
          continue;
        }
        // Primary-key addressed, like every belief write (0120).
        await db.query(
          `UPDATE $id SET statement = $text, statementSource = 'llm' WHERE statementSource = 'template'`,
          { id: new StringRecordId(id), text },
        );
        out.phrased += 1;
      }
    });
    this.logger.log(
      `harness work submitted ${companyId}: belief_statement beliefs=${out.beliefs} phrased=${out.phrased} stale=${out.stale}`,
    );
    return out;
  }

  private async pending(companyId: string, userId: string, limit: number): Promise<BeliefRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[BeliefRow[]]>(
        `SELECT id, subject, field, value, priorValue ?? '' AS priorValue, validFrom FROM semantic_belief
          WHERE status = 'active' AND statementSource = 'template' AND userId = $u
          ORDER BY validFrom ASC, id ASC LIMIT $k`,
        { u: userId, k: limit },
      );
      return rows ?? [];
    });
  }
}

function signatureOf(b: BeliefStatementInput): string {
  return pairSignature(b.subject, b.field, b.value, b.priorValue);
}
