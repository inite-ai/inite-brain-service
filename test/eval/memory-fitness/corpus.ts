/**
 * First-person seeded corpus: the working memory of one engineering
 * agent ("Argus") building the `ledger-sync` payment-reconciliation
 * service. Everything is written in the first person because the brain
 * under test IS this agent's memory — the corpus is what the agent
 * chose to remember, and questions.ts asks what the same agent would
 * ask weeks later.
 *
 * Engineered content (ground truth authored WITH the corpus):
 *  - four revision chains (decision made, then changed):
 *      A queue backend   : Redis Streams (03-02)  -> NATS JetStream (03-18)
 *      B retry policy    : fixed 3x30s   (03-10)  -> exp backoff cap 5 (03-18)
 *      C pilot launch    : 2026-04-15    (03-02)  -> 2026-05-06 (03-18)
 *      D deploy target   : Fly.io        (03-02)  -> AWS ECS Fargate (03-25)
 *  - stable facts: repo, ports (8443 / 9464 / 8081), staging namespace,
 *    flag prefix, dashboard name, Meridian sandbox rate limit;
 *  - one contradiction pair (two sources disagree): Meridian payout
 *    cutoff — Priya says 17:00 UTC, Meridian docs v2.3 say 16:30 UTC;
 *  - temporal anchors: every decision carries its date in the text;
 *  - entities spanning conversations: Meridian (c1, c2, c4, c5),
 *    Priya (c1, c2, c5), ls-staging (c1, c2, c5);
 *  - grounding mix in DIRECT_FACTS: 12 record_fact calls with
 *    evidence[] + conversationId, 3 deliberately ungrounded.
 *
 * Turns stay under ~550 chars so the provenance text cap (600 chars)
 * never truncates a seeded fragment away.
 */
import type { CorpusTurn, DirectFact } from './types';

/** The vertical every corpus write attributes itself to. */
export const CORPUS_VERTICAL = 'engineering';

/** The agent's own entity — first-person turns resolve to it. */
export const SPEAKER = {
  vertical: CORPUS_VERTICAL,
  id: 'agent-argus',
  role: 'speaker',
  name: 'Argus',
} as const;

/** Anchor entities attached to turns that mention them. */
export const LEDGER_SYNC_REF = { vertical: CORPUS_VERTICAL, id: 'ledger-sync' } as const;
export const MERIDIAN_REF = { vertical: CORPUS_VERTICAL, id: 'meridian' } as const;

/** Timestamp of turn N (1-based) — 5 minutes apart within a session. */
const t = (startIso: string, turn: number): string =>
  new Date(Date.parse(startIso) + (turn - 1) * 5 * 60_000).toISOString();

const conv = (conversation: string, startIso: string, texts: string[]): CorpusTurn[] =>
  texts.map((text, i) => ({
    conversation,
    turn: i + 1,
    emittedAt: t(startIso, i + 1),
    text,
  }));

// ── c1 — kickoff, 2026-03-02 ────────────────────────────────────────
const C1 = conv('c1', '2026-03-02T09:00:00Z', [
  'Kickoff log, 2026-03-02. I am starting ledger-sync, our payment-reconciliation worker. This memory is my source of truth for decisions on this project.',
  'The repository for ledger-sync is acme/ledger-sync on GitHub. All code and runbooks live there.',
  'Runtime decision: ledger-sync runs on Node 22 with TypeScript, package manager is pnpm.',
  'I picked port 8443 for the ledger-sync HTTP service. That is the port the service listens on everywhere: local, staging, production.',
  'Decision (2026-03-02): the job queue backend for ledger-sync is Redis Streams. Rationale: we already operate Redis and the team knows it.',
  'Decision (2026-03-02): we deploy ledger-sync to Fly.io for the pilot. Cheap, fast to iterate.',
  'The staging namespace for ledger-sync is ls-staging. Every pre-production experiment goes there, never to prod.',
  'Decision (2026-03-02): the pilot launch date for ledger-sync is 2026-04-15. That is the commitment I gave the payments team.',
  'Context: ledger-sync reconciles payouts against Meridian, the upstream bank API vendor. Meridian is the only external dependency of the pilot.',
  'Convention: all ledger-sync configuration comes from environment variables validated at boot. No config files in the image.',
  'Priya owns the Meridian integration on our side. Anything about Meridian contracts or credentials goes through Priya.',
  'Idiom: I record every decision as a dated log entry in this memory, and when I change a decision I write the new one with its date instead of editing the old.',
  'Kickoff done. Next session: triage of the duplicate payout report from the pilot ledger.',
]);

// ── c2 — bug hunt, 2026-03-10 ───────────────────────────────────────
const C2 = conv('c2', '2026-03-10T10:00:00Z', [
  'Bug-hunt log, 2026-03-10. Today I am chasing the duplicate payout bug in ledger-sync: one payout went out twice.',
  'Symptom: payout PA-1077 was paid twice on 2026-03-08. The ledger shows two identical transfers three minutes apart.',
  'Root cause found (2026-03-10): the retry handler re-enqueued payout jobs without an idempotency key, so a timed-out job ran twice. The duplicate payout was our own retry, not Meridian.',
  'Fix idiom (2026-03-10): every enqueue in ledger-sync now carries idempotencyKey = sha256(payoutId + attemptDate). The worker drops any job whose key it has already processed.',
  'Decision (2026-03-10): the retry policy for ledger-sync jobs is fixed — 3 retries with a 30s delay between attempts.',
  'For the record: ledger-sync calls the Meridian payouts API to fetch payout status. That integration is the hot path of the service.',
  'Constraint: the Meridian sandbox rate limit is 50 requests per minute. Exceeding it returns HTTP 429 and poisons the test run.',
  'Priya told me today that the Meridian payout cutoff is 17:00 UTC — payouts submitted after that settle the next banking day.',
  'I wrote a regression test that replays the double-enqueue: it fails without the idempotency key and passes with it.',
  'Postmortem note: the duplicate payout was a missing-idempotency bug in our retry path. Meridian behaved correctly throughout.',
  'Rule for future me: never retry a non-idempotent enqueue without an idempotency key. This is exactly how PA-1077 double-paid.',
  'Shipped the idempotency fix in commit 9f31c2d to acme/ledger-sync.',
  'Verified the fix in ls-staging: replayed the PA-1077 scenario, exactly one transfer went out.',
  'Bug-hunt done. The retry policy itself still feels crude; revisiting it at the architecture review.',
]);

// ── c3 — architecture revision, 2026-03-18 ──────────────────────────
const C3 = conv('c3', '2026-03-18T09:30:00Z', [
  'Architecture-review log, 2026-03-18. Several kickoff decisions do not survive contact with reality; I am revising them today.',
  'Decision (2026-03-18): the job queue backend for ledger-sync is now NATS JetStream. We need message replay and cross-region consumer groups, and JetStream gives us both.',
  'This supersedes my 2026-03-02 decision to use Redis Streams as the queue backend. Redis Streams is no longer the queue.',
  'Migration plan: dual-run the old and new queue until the end of the month, then cut over. No big-bang switch.',
  'Decision (2026-03-18): the retry policy for ledger-sync is now exponential backoff with full jitter, capped at 5 attempts. This replaces the fixed 3-retries-30s policy from 2026-03-10.',
  'Rationale for the retry change: fixed 30s retries synchronized into a thundering herd against the Meridian sandbox and tripped its rate limit.',
  'Decision (2026-03-18): the pilot launch date for ledger-sync moves from 2026-04-15 to 2026-05-06. The JetStream migration needs the extra three weeks.',
  'I told the payments team about the new 2026-05-06 launch date today; they signed off.',
  'A big win of JetStream: we can finally build replay tooling — re-consume any stream from a point in time. That was impossible to do cleanly before.',
  'Convention: JetStream subjects for ledger-sync are named LSYNC.payouts.* — one subject per payout state transition.',
  'Action item: update the runbooks in acme/ledger-sync for the new queue and retry policy.',
  'Risk: the team has not run JetStream in production before. I scheduled a pairing session with the platform team for next week.',
  'Recap of 2026-03-18: queue backend is NATS JetStream, retries are exponential backoff capped at 5 attempts, pilot launch is 2026-05-06.',
]);

// ── c4 — ops and conventions, 2026-03-25 ────────────────────────────
const C4 = conv('c4', '2026-03-25T14:00:00Z', [
  'Ops log, 2026-03-25. Today is about observability, conventions, and the deployment target for ledger-sync.',
  'The Prometheus metrics endpoint of ledger-sync listens on port 9464.',
  'Our Grafana dashboard for the service is called "LedgerSync Ops". Latency, queue depth, and payout lag live there.',
  'Convention: every ledger-sync feature flag is prefixed LSYNC_ — for example LSYNC_REPLAY_ENABLED. No unprefixed flags.',
  'The internal admin console of ledger-sync listens on port 8081. It is never exposed publicly.',
  'Ports taken by ledger-sync so far: 8443 for the HTTP service, 9464 for metrics, 8081 for the admin console. Pick something else for anything new.',
  'Decision (2026-03-25): ledger-sync deploys to AWS ECS Fargate instead of Fly.io. We need VPC peering with Meridian and the compliance team wants everything inside our AWS account. This replaces the 2026-03-02 Fly.io decision.',
  'Discrepancy found: the Meridian API docs v2.3 state the payout cutoff is 16:30 UTC. That contradicts what Priya was told (17:00 UTC). I need to resolve this with Meridian support before launch.',
  'Alerting rule: page the on-call when payout lag exceeds 15 minutes.',
  'Log retention for ledger-sync is 30 days in Loki.',
  'Now that we are on ECS, secrets move to AWS SSM Parameter Store. Nothing secret in task definitions.',
  'The JetStream cluster in ls-staging runs 3 nodes. Good enough for the pilot load test.',
  'Ops session done. Next: integration week with the replay tooling.',
]);

// ── c5 — integration week, 2026-04-02 ───────────────────────────────
const C5 = conv('c5', '2026-04-02T11:00:00Z', [
  'Integration log, 2026-04-02. Replay tooling and the outbox work land this week.',
  'Shipped the replay CLI: `pnpm replay --from <iso>` re-consumes the payout stream from our queue backend starting at that timestamp.',
  'Idiom (2026-04-02): ledger-sync emits domain events through an outbox table — write the event in the same transaction as the state change, and a relay publishes it. We never dual-write to the queue. This idiom exists because of the duplicate-payout postmortem.',
  'The outbox relay drains to the queue every 2 seconds. Lag beyond that shows up on the LedgerSync Ops dashboard.',
  'Rotated the Meridian sandbox credentials today; the new ones are in SSM under /lsync/meridian/sandbox.',
  'The PA-1077 double-payout regression test is green on the new queue backend too. The idempotency key protects the JetStream path exactly as it did before.',
  'Staging dry-run of the pilot passed in ls-staging on 2026-04-01: zero duplicate transfers, payout lag under 4 minutes.',
  'Launch check: we are on track for the 2026-05-06 pilot launch.',
  'Updated the README and runbooks in acme/ledger-sync with the replay CLI and the outbox idiom.',
  'Priya verified the Meridian integration against ECS staging today. Credentials, VPC peering, and payout status polling all work.',
  'The outbox relay reuses the enqueue idiom: idempotencyKey = sha256(payoutId + attemptDate), so replayed events cannot double-pay.',
  'Note to future me: the Meridian payout cutoff discrepancy (Priya: 17:00 UTC vs docs v2.3: 16:30 UTC) is still unresolved. Chase Meridian support before launch.',
  'Integration week done. Remaining before launch: load test at 2x pilot volume and the cutoff resolution.',
]);

/** All mention turns, chronological. */
export const CORPUS_TURNS: CorpusTurn[] = [...C1, ...C2, ...C3, ...C4, ...C5];

/**
 * Direct record_fact calls — the agent distilling its own log into
 * structured memory. 12 grounded (evidence[] + conversationId), 3
 * deliberately ungrounded (no evidence, no conversation) so the
 * grounding plane has both classes to stamp.
 *
 * Ordered chronologically by validFrom so revision chains replay the
 * way the agent lived them (old value recorded before its successor).
 */
export const DIRECT_FACTS: DirectFact[] = [
  {
    key: 'queue-v1',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'queue_backend',
    object: 'Redis Streams',
    validFrom: '2026-03-02T09:20:00Z',
    confidence: 0.9,
    conversation: 'c1',
    evidence: [{ kind: 'conversation', ref: 'c1', note: 'kickoff decision log' }],
  },
  {
    key: 'deploy-v1',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'deploy_target',
    object: 'Fly.io',
    validFrom: '2026-03-02T09:25:00Z',
    confidence: 0.9,
    conversation: 'c1',
    evidence: [{ kind: 'conversation', ref: 'c1', note: 'kickoff decision log' }],
  },
  {
    key: 'launch-v1',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'pilot_launch_date',
    object: '2026-04-15',
    validFrom: '2026-03-02T09:35:00Z',
    confidence: 0.9,
    conversation: 'c1',
    evidence: [{ kind: 'conversation', ref: 'c1', note: 'commitment to the payments team' }],
  },
  {
    key: 'service-port',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'service_port',
    object: '8443',
    validFrom: '2026-03-02T09:15:00Z',
    confidence: 0.95,
    conversation: 'c1',
    evidence: [{ kind: 'message', ref: 'c1:t04', note: 'port decision turn' }],
  },
  {
    key: 'repo',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'repository',
    object: 'acme/ledger-sync',
    validFrom: '2026-03-02T09:05:00Z',
    confidence: 0.95,
    conversation: 'c1',
    evidence: [{ kind: 'url', ref: 'https://github.com/acme/ledger-sync', note: 'repository' }],
  },
  {
    key: 'retry-v1',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'retry_policy',
    object: 'fixed: 3 retries with 30s delay',
    validFrom: '2026-03-10T10:20:00Z',
    confidence: 0.9,
    conversation: 'c2',
    evidence: [{ kind: 'message', ref: 'c2:t05', note: 'retry policy decision turn' }],
  },
  {
    key: 'cutoff-priya',
    entityRef: MERIDIAN_REF,
    predicate: 'payout_cutoff',
    object: '17:00 UTC',
    validFrom: '2026-03-10T10:35:00Z',
    confidence: 0.7,
    conversation: 'c2',
    evidence: [{ kind: 'message', ref: 'c2:t08', note: 'Priya, relayed from Meridian onboarding' }],
  },
  {
    key: 'queue-v2',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'queue_backend',
    object: 'NATS JetStream',
    validFrom: '2026-03-18T09:35:00Z',
    confidence: 0.9,
    conversation: 'c3',
    evidence: [{ kind: 'conversation', ref: 'c3', note: 'architecture revision session' }],
  },
  {
    key: 'retry-v2',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'retry_policy',
    object: 'exponential backoff with full jitter, max 5 attempts',
    validFrom: '2026-03-18T09:50:00Z',
    confidence: 0.9,
    conversation: 'c3',
    evidence: [{ kind: 'message', ref: 'c3:t05', note: 'retry revision turn' }],
  },
  {
    key: 'launch-v2',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'pilot_launch_date',
    object: '2026-05-06',
    validFrom: '2026-03-18T10:00:00Z',
    confidence: 0.9,
    conversation: 'c3',
    evidence: [{ kind: 'conversation', ref: 'c3', note: 'launch slip, payments team signed off' }],
  },
  {
    key: 'deploy-v2',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'deploy_target',
    object: 'AWS ECS Fargate',
    validFrom: '2026-03-25T14:30:00Z',
    confidence: 0.9,
    conversation: 'c4',
    evidence: [{ kind: 'message', ref: 'c4:t07', note: 'deploy revision turn' }],
  },
  {
    key: 'cutoff-docs',
    entityRef: MERIDIAN_REF,
    predicate: 'payout_cutoff',
    object: '16:30 UTC',
    validFrom: '2026-03-25T14:35:00Z',
    confidence: 0.7,
    conversation: 'c4',
    evidence: [
      {
        kind: 'document',
        ref: 'meridian-api-docs-v2.3',
        note: 'Meridian API docs v2.3, settlement',
      },
    ],
  },
  // ── deliberately ungrounded (no evidence, no conversationId) ──────
  {
    key: 'dashboard-ungrounded',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'grafana_dashboard',
    object: 'LedgerSync Ops',
    validFrom: '2026-03-25T14:10:00Z',
    confidence: 0.8,
  },
  {
    key: 'flag-prefix-ungrounded',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'feature_flag_prefix',
    object: 'LSYNC_',
    validFrom: '2026-03-25T14:15:00Z',
    confidence: 0.8,
  },
  {
    key: 'admin-port-ungrounded',
    entityRef: LEDGER_SYNC_REF,
    predicate: 'admin_console_port',
    object: '8081',
    validFrom: '2026-03-25T14:20:00Z',
    confidence: 0.8,
  },
];
