/**
 * F8 (audit 2026-09-06): the prior vote and the new vote used to be two
 * round-trips, so two concurrent votes from ONE actor both read "no prior
 * vote" and each emitted `+1 confirmedCount` — one standing vote counted
 * twice in the rollup. The vote is now cast and its prior read in ONE
 * transaction, and the rollup delta is derived from what the database
 * actually replaced.
 *
 * The fake here emulates a serialisable store at the transaction level:
 * each vote transaction takes a snapshot of the standing vote, is held at
 * a barrier until BOTH concurrent transactions have started (the audit's
 * interleaving), and then commits — unless another transaction committed
 * after its snapshot, in which case it aborts with the server's write
 * conflict and the service's retry re-runs it against the committed row.
 */
import { FeedbackService } from '../src/feedback/feedback.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactsService } from '../src/facts/facts.service';
import type { MemoryOutcomeService, StatDelta } from '../src/outcomes/memory-outcome.service';

interface Recorded {
  events: Array<{ event: string }>;
  statDeltas: StatDelta[];
}

function makeStore(opts: { barrier: number }) {
  let standing: string | undefined;
  let commits = 0;
  let started = 0;
  const waiters: Array<() => void> = [];
  const transactions: Array<{ prior: string | undefined; attempt: number }> = [];
  const attemptsByVerdict = new Map<string, number>();

  const query = async (sql: string, vars?: Record<string, unknown>) => {
    if (!sql.startsWith('BEGIN TRANSACTION') || !sql.includes('retrieval_feedback')) return [[]];
    const verdict = String(vars?.verdict);
    const attempt = (attemptsByVerdict.get(verdict) ?? 0) + 1;
    attemptsByVerdict.set(verdict, attempt);
    const snapshot = standing;
    const commitsAtSnapshot = commits;
    // Barrier: the first N transactions all read their snapshot before any
    // of them commits — the exact window the two-round-trip code raced in.
    started++;
    if (started <= opts.barrier) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length === opts.barrier) for (const w of waiters.splice(0)) w();
      });
    }
    if (commits > commitsAtSnapshot) {
      throw new Error(
        'Transaction conflict: Write conflict, retry the transaction. This transaction can be retried',
      );
    }
    standing = verdict;
    commits++;
    transactions.push({ prior: snapshot, attempt });
    // 3.x slot shape: BEGIN, LET, INSERT, RETURN, COMMIT.
    return [null, null, [{ verdict }], { prior: snapshot ?? null }, null];
  };
  return {
    query,
    transactions,
    standingVote: () => standing,
    attempts: (verdict: string) => attemptsByVerdict.get(verdict) ?? 0,
  };
}

function makeService(store: ReturnType<typeof makeStore>) {
  const recorded: Recorded[] = [];
  const surreal = {
    withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) =>
      fn({ query: store.query }),
  } as unknown as SurrealService;
  const facts = { getFact: async () => ({}) } as unknown as FactsService;
  const outcomes = {
    recordOutcomes: (o: Recorded) => recorded.push(o),
  } as unknown as MemoryOutcomeService;
  const svc = new FeedbackService(surreal, facts, undefined, outcomes);
  return { svc, recorded };
}

const sum = (recorded: Recorded[], counter: string) =>
  recorded
    .flatMap((r) => r.statDeltas)
    .filter((d) => d.counter === counter)
    .reduce((n, d) => n + d.delta, 0);

describe('feedback — one standing vote, one rollup delta, under concurrency (F8)', () => {
  const vote = (verdict: 'helpful' | 'incorrect') => ({
    companyId: 'co_a',
    factId: 'knowledge_fact:f',
    verdict,
    actor: 'same_actor',
    scopes: ['brain:read', 'brain:write'] as const,
  });

  beforeEach(() => {
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
  });

  it('two concurrent helpful votes from one actor net exactly +1 confirmedCount', async () => {
    const store = makeStore({ barrier: 2 });
    const { svc, recorded } = makeService(store);
    const [a, b] = await Promise.all([svc.record(vote('helpful')), svc.record(vote('helpful'))]);
    // Exactly one of the two saw the other's row as its prior.
    expect([a.replaced, b.replaced].sort()).toEqual([false, true]);
    expect(store.standingVote()).toBe('helpful');
    // The loser aborted on the conflict and was re-run against the
    // committed row — its retry is what makes the delta correct.
    expect(store.attempts('helpful')).toBe(3);
    expect(store.transactions.map((t) => t.prior)).toEqual([undefined, 'helpful']);
    // Rollup: +1 once. The same-verdict replacement nets zero (no delta).
    expect(sum(recorded, 'confirmedCount')).toBe(1);
    // Raw audit trail: both votes are appended as events, by contract.
    expect(recorded.flatMap((r) => r.events).map((e) => e.event)).toEqual([
      'user_confirmed',
      'user_confirmed',
    ]);
  });

  it('a concurrent helpful + incorrect from one actor leaves exactly one bucket at 1', async () => {
    const store = makeStore({ barrier: 2 });
    const { svc, recorded } = makeService(store);
    await Promise.all([svc.record(vote('helpful')), svc.record(vote('incorrect'))]);
    const confirmed = sum(recorded, 'confirmedCount');
    const rejected = sum(recorded, 'rejectedCount');
    // Whichever verdict stands, the rollup agrees with the standing vote.
    expect(confirmed + rejected).toBe(1);
    expect(store.standingVote() === 'helpful' ? confirmed : rejected).toBe(1);
  });

  it('a sequential helpful → incorrect replacement moves the vote between buckets', async () => {
    const store = makeStore({ barrier: 0 });
    const { svc, recorded } = makeService(store);
    expect((await svc.record(vote('helpful'))).replaced).toBe(false);
    expect((await svc.record(vote('incorrect'))).replaced).toBe(true);
    expect(sum(recorded, 'confirmedCount')).toBe(0);
    expect(sum(recorded, 'rejectedCount')).toBe(1);
  });

  it('the prior is read inside the same transaction that writes the vote', async () => {
    const seen: string[] = [];
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) =>
        fn({
          query: async (sql: string) => {
            seen.push(sql);
            return [null, null, [], { prior: null }, null];
          },
        }),
    } as unknown as SurrealService;
    const facts = { getFact: async () => ({}) } as unknown as FactsService;
    const svc = new FeedbackService(surreal, facts);
    await svc.record(vote('helpful'));
    expect(seen).toHaveLength(1);
    const [sql] = seen;
    expect(sql).toMatch(/^BEGIN TRANSACTION;/);
    expect(sql).toContain('LET $prior = (SELECT VALUE verdict FROM retrieval_feedback');
    expect(sql).toContain('INSERT INTO retrieval_feedback');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('RETURN { prior: $prior }');
    expect(sql).toMatch(/COMMIT TRANSACTION;$/);
  });
});
