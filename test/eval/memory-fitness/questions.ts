/**
 * The question set — what the SAME agent would genuinely ask its memory
 * weeks later, with expectations authored together with the corpus so
 * every check is mechanical. One block per fitness dimension (D1-D8);
 * see README.md for what each dimension measures and why.
 */
import type { Question } from './types';

export const QUESTIONS: Question[] = [
  // ── D1 — state currency: current value served, stale value absent ──
  {
    id: 'd1-queue',
    dimension: 'D1',
    kind: 'currency',
    prompt: 'What is the current job queue backend for ledger-sync?',
    expectAnyOf: ['JetStream', 'NATS'],
    forbidAnyOf: ['Redis'],
  },
  {
    id: 'd1-retry',
    dimension: 'D1',
    kind: 'currency',
    prompt: 'What retry policy does ledger-sync use for jobs right now?',
    expectAnyOf: ['exponential'],
    forbidAnyOf: ['fixed', '30s delay', '30 second'],
  },
  {
    id: 'd1-launch',
    dimension: 'D1',
    kind: 'currency',
    prompt: 'When is the ledger-sync pilot launching?',
    expectAnyOf: ['2026-05-06', 'May 6', '6 May'],
    forbidAnyOf: ['2026-04-15', 'April 15', '15 April'],
  },
  {
    id: 'd1-deploy',
    dimension: 'D1',
    kind: 'currency',
    prompt: 'Where does ledger-sync deploy to?',
    expectAnyOf: ['ECS', 'Fargate'],
    forbidAnyOf: ['Fly.io'],
  },

  // ── D2 — evolution history: old + new both retained, ordered ──────
  {
    id: 'd2-queue',
    dimension: 'D2',
    kind: 'evolution',
    prompt: 'How has the ledger-sync queue backend decision evolved?',
    entityQuery: 'ledger-sync queue backend',
    predicate: 'queue_backend',
    oldMarkers: ['Redis Streams'],
    newMarkers: ['JetStream'],
  },
  {
    id: 'd2-retry',
    dimension: 'D2',
    kind: 'evolution',
    prompt: 'How has the ledger-sync retry policy evolved?',
    entityQuery: 'ledger-sync retry policy',
    predicate: 'retry_policy',
    oldMarkers: ['fixed'],
    newMarkers: ['exponential'],
  },
  {
    id: 'd2-launch',
    dimension: 'D2',
    kind: 'evolution',
    prompt: 'How has the ledger-sync pilot launch date moved?',
    entityQuery: 'ledger-sync pilot launch date',
    predicate: 'pilot_launch_date',
    oldMarkers: ['2026-04-15'],
    newMarkers: ['2026-05-06'],
  },
  {
    id: 'd2-beliefs',
    dimension: 'D2',
    kind: 'belief-evolution',
    prompt: 'Does the promoted belief about the queue backend carry its prior value?',
    valueMarkers: ['JetStream', 'NATS'],
    priorMarkers: ['Redis'],
  },

  // ── D3 — provenance unrollability: claim -> episode -> seeded turn ─
  {
    id: 'd3-idempotency',
    dimension: 'D3',
    kind: 'provenance',
    prompt: 'Provenance of the duplicate-payout root cause reaches the bug-hunt turn.',
    searchQuery: 'duplicate payout root cause idempotency key retry',
    predicateHint: '',
    episodeFragments: ['idempotency'],
  },
  {
    id: 'd3-ratelimit',
    dimension: 'D3',
    kind: 'provenance',
    prompt: 'Provenance of the Meridian sandbox rate limit reaches the constraint turn.',
    searchQuery: 'Meridian sandbox rate limit requests per minute',
    predicateHint: '',
    episodeFragments: ['50 requests per minute'],
  },
  {
    id: 'd3-outbox',
    dimension: 'D3',
    kind: 'provenance',
    prompt: 'Provenance of the outbox idiom reaches the integration-week turn.',
    searchQuery: 'outbox table domain events dual-write',
    predicateHint: '',
    episodeFragments: ['outbox'],
  },

  // ── D4 — temporal anchors: dated decisions come back dated ────────
  {
    id: 'd4-nats-date',
    dimension: 'D4',
    kind: 'temporal',
    prompt: 'When did we decide to switch the ledger-sync queue to NATS JetStream?',
    expectDate: '2026-03-18',
  },
  {
    id: 'd4-rootcause-date',
    dimension: 'D4',
    kind: 'temporal',
    prompt: 'When did we find the root cause of the duplicate payout bug?',
    expectDate: '2026-03-10',
  },
  {
    id: 'd4-kickoff-date',
    dimension: 'D4',
    kind: 'temporal',
    prompt: 'When did the ledger-sync project kick off?',
    expectDate: '2026-03-02',
  },
  {
    id: 'd4-launch-date',
    dimension: 'D4',
    kind: 'temporal',
    prompt: 'What is the current pilot launch date for ledger-sync?',
    expectDate: '2026-05-06',
  },

  // ── D5 — absence honesty: never-written topics must abstain ───────
  {
    id: 'd5-warehouse',
    dimension: 'D5',
    kind: 'absence',
    prompt: 'What database does the ledger-sync analytics warehouse use?',
  },
  {
    id: 'd5-oncall',
    dimension: 'D5',
    kind: 'absence',
    prompt: 'Who leads the on-call rotation for ledger-sync?',
  },
  {
    id: 'd5-mobile',
    dimension: 'D5',
    kind: 'absence',
    prompt: 'What did we decide about the ledger-sync mobile client SDK?',
  },
  {
    id: 'd5-sla',
    dimension: 'D5',
    kind: 'absence',
    prompt: "What is Meridian's production API latency SLA?",
  },
  {
    id: 'd5-postgres',
    dimension: 'D5',
    kind: 'absence',
    prompt: 'Which Postgres version does ledger-sync run in production?',
  },

  // ── D6 — conflict surfacing: both sides of the cutoff disagreement ─
  {
    id: 'd6-competing-api',
    dimension: 'D6',
    kind: 'conflict-api',
    prompt: 'The competing-facts API lists both payout-cutoff sources for Meridian.',
    entityQuery: 'Meridian payout cutoff',
    predicate: 'payout_cutoff',
    sideA: ['17:00'],
    sideB: ['16:30'],
  },
  {
    id: 'd6-answer',
    dimension: 'D6',
    kind: 'conflict-answer',
    prompt: "What is Meridian's payout cutoff time?",
    sideA: ['17:00'],
    sideB: ['16:30'],
  },

  // ── D7 — cross-session integration: join two conversations ────────
  {
    id: 'd7-port',
    dimension: 'D7',
    kind: 'integration',
    prompt: 'What port does the service that talks to the Meridian API listen on?',
    expectAnyOf: ['8443'],
  },
  {
    id: 'd7-replay',
    dimension: 'D7',
    kind: 'integration',
    prompt: 'Which queue backend does the replay CLI re-consume the payout stream from?',
    expectAnyOf: ['JetStream', 'NATS'],
  },
  {
    id: 'd7-vendor',
    dimension: 'D7',
    kind: 'integration',
    prompt: 'Which vendor API does the service launching on 2026-05-06 integrate with?',
    expectAnyOf: ['Meridian'],
  },

  // ── D8 — self-utility replay: asked exactly as a returning agent ──
  {
    id: 'd8-enqueue-idiom',
    dimension: 'D8',
    kind: 'replay',
    prompt: 'What idiom do we use for enqueueing jobs in ledger-sync, and why?',
    keyPhrases: [
      ['idempotencyKey', 'idempotency key', 'idempotency'],
      ['duplicate', 'double'],
    ],
  },
  {
    id: 'd8-ports-taken',
    dimension: 'D8',
    kind: 'replay',
    prompt: 'Which ports are already taken on the ledger-sync deployment?',
    keyPhrases: ['8443', '9464', '8081'],
  },
  {
    id: 'd8-flag-prefix',
    dimension: 'D8',
    kind: 'replay',
    prompt: 'What is the naming convention for ledger-sync feature flags?',
    keyPhrases: ['LSYNC_'],
  },
  {
    id: 'd8-events-pattern',
    dimension: 'D8',
    kind: 'replay',
    prompt: 'How should I emit domain events from the database — what is our pattern?',
    keyPhrases: ['outbox'],
  },
  {
    id: 'd8-ratelimit',
    dimension: 'D8',
    kind: 'replay',
    prompt: 'What Meridian sandbox rate limit do I need to respect?',
    keyPhrases: ['50'],
  },
];
