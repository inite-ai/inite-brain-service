import type { DomainPackManifest } from './manifest';

/**
 * Source pack: CHAT. DISTRIBUTABLE (installed per-tenant from
 * `packs/chat-memory.pack.json`, NOT in BUILTIN_PACKS). The carrier of
 * the chat source entries — the channels of a Slack workspace, the
 * groups a Telegram bot is in — and of the vocabulary a chat yields.
 * Chat is conversation-shaped (raw-evidence-sources-2026-09.md doctrine
 * 2): every message is ONE TURN of its channel or thread and enters
 * through the mention door → episodes, the author as the speaker; the
 * facts below are what people SAY in chat — what they ask, agree,
 * decide, take on and are blocked by — never who is in the channel.
 *
 * Bump `version` to update.
 */
export const CHAT_MEMORY_PACK: DomainPackManifest = {
  id: 'chat_memory',
  version: '0.1.0',
  description:
    'Chat as memory — what people ask, agree, decide, take on and are blocked by in their channels and threads; the source pack that connects a Slack workspace or a Telegram bot.',
  predicates: [
    {
      localId: 'asked',
      displayLabel: 'asked',
      description: `TYPE   subject is a person (the author); value is what they asked the channel for
ADMIT  the message asks for something concrete — a review, a decision, a file,
       an answer ("can someone review the PR", "who owns the invoice job?")
VALUE  the request, short ("a review of the PR")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 30,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'agreed',
      displayLabel: 'agreed',
      description: `TYPE   subject is a person; value is what they agreed to
ADMIT  the author says yes to a proposal, a plan, a date ("ok, Thursday works",
       "agreed, let's ship v2 first") — a plain acknowledgement ("ok") is NOT an agreement
VALUE  what was agreed ("ship v2 first")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 60,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'decided',
      displayLabel: 'decided',
      description: `TYPE   subject is a person or a team; value is the decision they state
ADMIT  the message states a decision as made — "we're going with Postgres",
       "launch moves to the 3rd", "approved"
VALUE  the decision, short ("go with Postgres")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'took_on',
      displayLabel: 'took on',
      description: `TYPE   subject is a person; value is the task they took on
ADMIT  the author takes a task ("I'll take the migration", "on it", "mine") or is
       explicitly assigned one and does not object
VALUE  the task ("the migration")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 60,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'blocked_by',
      displayLabel: 'blocked by',
      description: `TYPE   subject is a person or a task; value is what blocks it
ADMIT  the message names a blocker — "blocked on the API key", "waiting for legal",
       "can't deploy until the cert is renewed"
VALUE  the blocker ("the API key")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 30,
      piiClass: 'none',
      status: 'active',
    },
    {
      localId: 'discussed',
      displayLabel: 'discussed',
      description: `TYPE   subject is a person (the author); value is the matter the message is about
ADMIT  the message is clearly about a named matter — a feature, an incident, a
       customer, a release ("the checkout bug", "the Northwind renewal")
VALUE  the matter as named ("the checkout bug")`,
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: 90,
      piiClass: 'none',
      status: 'active',
    },
  ],
  extractionProfile: {
    guidance: `Inputs are CHAT MESSAGES as turns — a channel or a thread, every turn one
message, the author as the speaker, mentions already resolved to names. Treat
each AUTHOR as one entity and extract what they ASK (chat_memory__asked), AGREE
TO (chat_memory__agreed), DECIDE (chat_memory__decided), TAKE ON
(chat_memory__took_on), name as a BLOCKER (chat_memory__blocked_by) and what
MATTER they write about (chat_memory__discussed). Only what the message SAYS;
a bare "ok" or an emoji is nothing. Attachments are named in brackets — a
named file is not a request. Copy names VERBATIM.`,
    fewShot: [
      {
        text: "Grace Hopper: Can someone review the checkout PR today? I'll take the migration after. We're going with Postgres, decided. Blocked on the API key for staging.",
        note: "author 'Grace Hopper' → chat_memory__asked='a review of the checkout PR', chat_memory__took_on='the migration', chat_memory__decided='go with Postgres', chat_memory__blocked_by='the API key for staging', chat_memory__discussed='the checkout PR'.",
      },
    ],
  },
  evalFixtures: [
    {
      id: 'asked',
      description: 'a request to the channel is captured on the author',
      text: 'Grace Hopper: Can someone review the checkout PR today?',
      expect: { facts: [{ predicate: 'asked', objectIncludes: 'checkout PR' }] },
    },
    {
      id: 'took_on',
      description: 'a task the author takes is captured',
      text: "Linus Berg: I'll take the migration.",
      expect: { facts: [{ predicate: 'took_on', objectIncludes: 'migration' }] },
    },
    {
      id: 'blocked_by',
      description: 'a named blocker is captured',
      text: 'Ada Lovelace: Blocked on the API key for staging.',
      expect: { facts: [{ predicate: 'blocked_by', objectIncludes: 'API key' }] },
    },
  ],
  memoryModel: {
    attentionHints: [
      { cue: 'can someone', prefer: ['asked'], zoom: ['facts'], weight: 0.5 },
      { cue: 'agreed', prefer: ['agreed', 'decided'], zoom: ['facts'], weight: 0.5 },
      { cue: 'decided', prefer: ['decided'], zoom: ['facts'], weight: 0.6 },
      { cue: "i'll take", prefer: ['took_on'], zoom: ['facts'], weight: 0.6 },
      { cue: 'blocked', prefer: ['blocked_by'], zoom: ['facts'], weight: 0.6 },
      { cue: 'waiting for', prefer: ['blocked_by'], zoom: ['facts'], weight: 0.4 },
    ],
    retentionHints: [
      { predicateOrScene: 'asked', hint: 'ephemeral' },
      { predicateOrScene: 'agreed', hint: 'standard' },
      { predicateOrScene: 'decided', hint: 'durable' },
      { predicateOrScene: 'took_on', hint: 'standard' },
      { predicateOrScene: 'blocked_by', hint: 'ephemeral' },
      { predicateOrScene: 'discussed', hint: 'ephemeral' },
    ],
    // ── Media contract (Evidence Plane) ─────────────────────────────────
    // Text only: files shared in chat are named in the turn, not read.
    modalities: ['text'],
  },
  sources: [
    // ── Slack (W4.7): a connected workspace's bot, or a bot token.
    {
      id: 'slack',
      kind: 'native',
      connector: 'slack',
      shape: 'conversation',
      title: 'Slack (channels as conversations)',
      description:
        'The channels a Slack app is a member of — every message one turn of its channel or thread through the mention door: the author as the speaker, mrkdwn reduced to text, mentions resolved, files named; newest first from `since`, then only what is newer than the checkpoint. config: { channels?, since?, maxMessages?, includeThreads? }; credential: a connected workspace, or a bot token (xoxb-…).',
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: '1h' },
    },
    // ── Telegram (W4.7): a bot in the groups, polling getUpdates.
    {
      id: 'telegram',
      kind: 'native',
      connector: 'telegram',
      shape: 'conversation',
      title: 'Telegram (a bot in your groups)',
      description:
        'The groups, supergroups and channels a Telegram bot is in, read through getUpdates as the bot — a feed: what arrives after the bot joined, acknowledged as it is read, never re-read and never marked gone; every message one turn of its chat or topic, the sender as the speaker, media named. config: { chats?, maxMessages? }; credential: the bot token from @BotFather.',
      defaults: { contentPolicy: 'text', deletePolicy: 'keep', schedule: '15m' },
    },
  ],
};
