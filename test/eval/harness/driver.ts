import { ABSTAIN_RE } from '../abstain';
import { loadCheckpoint, appendCheckpoint } from '../checkpoint';
import type { LlmJudge } from '../locomo/judge';
import { runPool } from './pool';
import { TenantClient } from './tenant-client';
import { EvalQuestion, EvalScore, EvalWorld } from './types';

/**
 * World-axis driver: ingest each world into its own tenant (episode-only
 * capture → batch derivation → segment composition), answer its dated
 * questions through /v1/search/multi-hop, grade with the strict judge,
 * checkpoint every finished row. The dataset-specific runners
 * (run-longmemeval.ts, run-beam.ts) only map their corpus into
 * EvalWorld[] and shape the final report.
 */

/** Protocol constant shared by all world axes (same cap FC would see). */
export const TURN_CHAR_CAP = 8000;
const TURN_STEP_MS = 30_000;
/** Sub-session jump must exceed the deriver's 1h inactivity gap. */
const CHUNK_JUMP_MS = 2 * 3600_000;

export interface DriverOptions {
  brainUrl: string;
  apiKey: string;
  derivedVersion: string;
  concurrency: number;
  skipIngest: boolean;
  resume?: string;
  judge?: LlmJudge;
  /**
   * Split long sessions into sub-sessions of this many turns (emittedAt
   * jumps past the deriver's inactivity gap) so each batch derivation
   * call sees a bounded transcript. Unset = natural sessions.
   */
  chunkTurns?: number;
  log?: (message: string) => void;
}

/**
 * Speaker entity name the deriver will resolve: `<convSlug>__<role>`,
 * where convSlug is the conversationRef after the last ':' with '-'→'_'
 * (must mirror window-deriver.service.ts exactly).
 */
export function speakerEntityName(
  conversationRef: string,
  role: string,
): string {
  const slug = conversationRef
    .slice(conversationRef.lastIndexOf(':') + 1)
    .toLowerCase()
    .replace(/-/g, '_');
  return `${slug}__${role}`;
}

/** Turn schedule: 30s per turn; every chunkTurns, jump past the gap. */
export function emittedAtIso(
  sessionBaseMs: number,
  turnIndex: number,
  chunkTurns?: number,
): string {
  const chunk = chunkTurns ? Math.floor(turnIndex / chunkTurns) : 0;
  const step = chunkTurns ? turnIndex % chunkTurns : turnIndex;
  return new Date(
    sessionBaseMs + chunk * CHUNK_JUMP_MS + step * TURN_STEP_MS,
  ).toISOString();
}

async function ingestWorld(
  world: EvalWorld,
  client: TenantClient,
  opts: DriverOptions,
  log: (m: string) => void,
): Promise<void> {
  const roles = [
    ...new Set(world.sessions.flatMap((s) => s.turns.map((t) => t.role))),
  ];
  // validFrom is REQUIRED by the ingest DTO (live-run finding: the fake-
  // fetch specs can't see DTO validation) — earliest session date, same
  // convention as the LoCoMo ingest sink.
  const validFrom = world.sessions[0]?.dateIso ?? new Date(0).toISOString();
  for (const role of roles) {
    const name = speakerEntityName(world.conversationRef, role);
    await client.call('POST', '/v1/ingest/fact', {
      entityRef: { vertical: world.vertical, id: name, name, type: 'person' },
      predicate: 'name',
      object: name,
      validFrom,
      source: { vertical: world.vertical, recorder: `${world.vertical}-harness` },
    });
  }
  let turnTotal = 0;
  for (const session of world.sessions) {
    const base = new Date(session.dateIso).getTime();
    for (const [i, turn] of session.turns.entries()) {
      await client.call('POST', '/v1/ingest/mention', {
        text: turn.content.slice(0, TURN_CHAR_CAP),
        contextRef: {
          vertical: world.vertical,
          conversationId: world.conversationRef,
          messageId: `${session.sessionId}:${i}`,
        },
        knownEntities: [
          {
            vertical: world.vertical,
            id: speakerEntityName(world.conversationRef, turn.role),
            role: 'speaker',
            name: speakerEntityName(world.conversationRef, turn.role),
          },
        ],
        emittedAt: emittedAtIso(base, i, opts.chunkTurns),
      });
      turnTotal += 1;
    }
  }
  log(`ingested ${turnTotal} turns`);
  const derived = await client.call<{ propositions: number }>(
    'POST',
    '/v1/admin/maintenance/derive',
    { version: opts.derivedVersion, force: true },
  );
  const segs = await client.call<{ segments: number }>(
    'POST',
    '/v1/admin/maintenance/segments',
    {},
  );
  log(`derived ${derived.propositions} props, ${segs.segments} segments`);
}

async function answerQuestion(
  q: EvalQuestion,
  client: TenantClient,
  world?: EvalWorld,
): Promise<EvalScore> {
  const score: EvalScore = {
    questionId: q.id,
    group: q.group,
    question: q.question,
    gold: q.gold,
    prediction: '',
    isAbstention: q.isAbstention,
    abstained: false,
    ...(q.meta ?? {}),
  };
  try {
    const query =
      world?.personaHint === true
        ? `${q.question}\n(First person "I"/"my" refers to ${speakerEntityName(world.conversationRef, 'user')}; the assistant in the conversation is ${speakerEntityName(world.conversationRef, 'assistant')}.)`
        : q.question;
    const res = await client.call<{
      synthesis?: {
        answer: string | null;
        tokenUsage?: { promptTokens: number };
      };
    }>('POST', '/v1/search/multi-hop', {
      query,
      synthesize: true,
      synthesisGuardrails: q.isAbstention ? 'lenient' : 'answer',
      asOf: q.askedAtIso,
    });
    score.prediction = res.synthesis?.answer ?? '';
    score.promptTokens = res.synthesis?.tokenUsage?.promptTokens;
  } catch (e) {
    score.errored = (e as Error).message;
  }
  score.abstained =
    !score.errored &&
    (!score.prediction.trim() || ABSTAIN_RE.test(score.prediction));
  return score;
}

function erroredScore(q: EvalQuestion, message: string): EvalScore {
  return {
    questionId: q.id,
    group: q.group,
    question: q.question,
    gold: q.gold,
    prediction: '',
    isAbstention: q.isAbstention,
    abstained: false,
    errored: message,
    ...(q.meta ?? {}),
  };
}

export async function runWorlds(
  axis: string,
  worlds: EvalWorld[],
  opts: DriverOptions,
): Promise<{ scores: EvalScore[]; checkpointed: number }> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const done = await loadCheckpoint<EvalScore>(
    opts.resume,
    (s) => s.questionId,
  );
  const scores: EvalScore[] = [...done.values()];

  await runPool(opts.concurrency, worlds, async (world, i) => {
    const tag = `[${axis} ${i + 1}/${worlds.length} ${world.conversationRef}]`;
    const pending = world.questions.filter((q) => !done.has(q.id));
    if (pending.length === 0) {
      log(`${tag} fully checkpointed, skipping`);
      return;
    }
    try {
      if (!opts.skipIngest) {
        const client = new TenantClient(
          opts.brainUrl,
          opts.apiKey,
          world.tenant,
        );
        await ingestWorld(world, client, opts, (m) => log(`${tag} ${m}`));
      }
      const client = new TenantClient(opts.brainUrl, opts.apiKey, world.tenant);
      for (const q of pending) {
        const s = await answerQuestion(q, client, world);
        let judgeFailed = false;
        if (opts.judge && !q.isAbstention && !s.errored) {
          try {
            s.judgeCorrect = (
              await opts.judge.grade({
                question: q.question,
                gold: q.judgeGold ?? q.gold,
                prediction: s.prediction,
                category: 0, // non-LoCoMo axis — prompt context only
              })
            ).correct;
          } catch (e) {
            judgeFailed = true;
            log(`${tag} judge error: ${(e as Error).message}`);
          }
        }
        scores.push(s);
        // Errored or unjudged-by-failure rows are NOT checkpointed —
        // a resume retries them instead of freezing the gap forever.
        if (!s.errored && !judgeFailed) await appendCheckpoint(opts.resume, s);
        log(
          `${tag} ${q.id} ${
            s.errored
              ? 'ERROR'
              : q.isAbstention
                ? `abstain=${s.abstained}`
                : `judge=${s.judgeCorrect}`
          }`,
        );
      }
    } catch (e) {
      log(`${tag} PIPELINE ERROR: ${(e as Error).message}`);
      for (const q of pending) scores.push(erroredScore(q, (e as Error).message));
    }
  });
  return { scores, checkpointed: done.size };
}
