/**
 * Chat as memory, end to end on a REAL SurrealDB (W4.7), against the
 * fake chat servers:
 *  - Slack: OAuth v2 (a form token endpoint answering the workspace's
 *    BOT token, no refresh, no PKCE; `ok: false` is the failure shape),
 *    then a sync walks the channels the bot is a member of — one row per
 *    message, mrkdwn reduced to text and mentions resolved, a root with
 *    replies followed into its thread (one conversation), a channel the
 *    bot is not in skipped; an incremental run reads only what is newer
 *    than the checkpoint; a refused token and a missing scope are named;
 *  - Telegram: the bot token as the credential and the Bot API on
 *    loopback — a FEED: getUpdates acknowledges what it read (the
 *    offset moves), a "full" run is still incremental and marks nothing
 *    gone, the chats filter keeps one group, and a bot with a webhook
 *    set is named with the remedy.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CHAT_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeChat, type FakeChat } from './fixtures/fake-chat';

const COMPANY = 'co_chat_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_SLACK',
  'SOURCE_KIND_TELEGRAM',
  'SOURCE_OAUTH_SLACK_CLIENT_ID',
  'SOURCE_OAUTH_SLACK_CLIENT_SECRET',
  'SOURCE_OAUTH_SLACK_BASE_URL',
  'SOURCE_TELEGRAM_API_BASE',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

interface Episode {
  conversationId: string;
  messageId: string;
  speaker: string | null;
  text: string;
  occurredAt: string;
}

/** A Slack ts from an ISO instant (seconds.microseconds). */
const ts = (iso: string, n = 0): string =>
  `${String(Math.floor(Date.parse(iso) / 1000))}.${String(100 + n).padStart(6, '0')}`;

describe('chat vendors: slack / telegram (e2e)', () => {
  let f: AppFixture;
  let chat: FakeChat;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    chat = await startFakeChat();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_SLACK: '1',
      SOURCE_KIND_TELEGRAM: '1',
      SOURCE_OAUTH_SLACK_CLIENT_ID: 'sl-client',
      SOURCE_OAUTH_SLACK_CLIENT_SECRET: 'sl-secret',
      SOURCE_OAUTH_SLACK_BASE_URL: chat.base,
      SOURCE_TELEGRAM_API_BASE: chat.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      EPISODE_SUBSTRATE_ENABLED: '1',
      INGEST_EPISODE_ONLY: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seedSlack(chat);
    seedTelegram(chat);
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: CHAT_MEMORY_PACK, acceptSources: true });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await chat.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const connect = (body: Record<string, unknown>) =>
    f.http.post('/v1/admin/source-connections').set(auth()).send(body);
  const sync = (id: string, full = false) =>
    f.http.post(`/v1/admin/source-connections/${id}/sync`).set(auth()).send({ inline: true, full });
  const items = (id: string) =>
    f.http.get(`/v1/admin/source-connections/${id}/items?limit=100`).set(auth());
  const episodesOf = (recorder: string) =>
    rows<Episode>(
      `SELECT conversationId, messageId, speaker, text, occurredAt FROM episode WHERE source.recorder = $recorder ORDER BY occurredAt ASC`,
      { recorder },
    );

  it('slack: the workspace connects (bot token, no refresh), the channels the bot is in become conversations, threads stay one', async () => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'slack', connector: 'slack' });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.origin).toBe(chat.base);
    expect(authorize.searchParams.get('scope')).toContain('channels:history');
    expect(authorize.searchParams.has('code_challenge')).toBe(false);
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    const cb = await f.http.get(`${back.pathname}${back.search}`);
    expect(cb.text).toContain('Connected Acme (slack)');
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'slack');
    expect(grant).toMatchObject({ account: 'Acme', refreshable: false, accessExpiresAt: null });
    // The token exchange carried the app's credentials in the form body, no verifier.
    const exchange = chat.calls.find((c) => c.path === '/api/oauth.v2.access')!;
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('sl-secret');
    expect(new URLSearchParams(exchange.body).has('code_verifier')).toBe(false);

    const conn = await connect({
      packId: 'chat_memory',
      sourceId: 'slack',
      vertical: 'chat',
      label: 'Slack',
      config: { since: '2026-09-01' },
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'full',
      seen: 4,
      fetched: 4,
      ingested: 4,
      failed: 0,
    });

    const eps = await episodesOf(conn.body.recorder);
    expect(eps).toHaveLength(4);
    // The thread root and its reply are ONE conversation; the plain message is the channel's.
    const thread = eps.filter(
      (e) => e.conversationId === `slack:T0ACME/C_GEN/${ts('2026-09-15T10:00:00Z')}`,
    );
    // The door prefixes the speaker into the turn (`Name: text`) — that IS the
    // episode's text; the episode's own `speaker` column is for resolved
    // participants, which a source connection does not name.
    expect(thread.map((e) => e.messageId)).toEqual([
      ts('2026-09-15T10:00:00Z'),
      ts('2026-09-15T10:05:00Z'),
    ]);
    expect(thread[0]!.text).toBe(
      'Grace Hopper: Can someone review the checkout PR in #deploys? spec (https://acme.test/spec)',
    );
    expect(thread[1]!.text).toBe(
      'Linus Berg: On it, @Grace Hopper.\n\n[attachment: review-notes.txt]',
    );
    const plain = eps.find(
      (e) =>
        e.conversationId === 'slack:T0ACME/C_GEN' && e.messageId === ts('2026-09-15T12:00:00Z'),
    );
    expect(plain?.text).toBe('Grace Hopper: Blocked on the API key for staging.');
    // The private channel the bot is in is read; the channel it is not in is not.
    expect(eps.some((e) => e.conversationId === 'slack:T0ACME/C_OPS')).toBe(true);
    const catalogue = await items(conn.body.id);
    expect(
      catalogue.body.items.every(
        (i: { externalId: string }) => !i.externalId.startsWith('C_RANDOM'),
      ),
    ).toBe(true);
    expect(
      catalogue.body.items.find(
        (i: { externalId: string }) => i.externalId === `C_GEN/${ts('2026-09-15T12:00:00Z')}`,
      ),
    ).toMatchObject({
      revision: `ts:${ts('2026-09-15T12:00:00Z')}`,
      originUri: expect.stringContaining('acme.slack.com/archives/C_GEN/p'),
      title: 'Blocked on the API key for staging.',
    });
    // The title reads like the turn will: mrkdwn reduced, the mention left as its id.
    expect(
      catalogue.body.items.find(
        (i: { externalId: string }) => i.externalId === `C_GEN/${ts('2026-09-15T10:05:00Z')}`,
      ),
    ).toMatchObject({ title: 'On it, @U_GRACE.' });

    // Nothing new: the incremental run reads from the checkpoint and ingests nothing.
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({ status: 'succeeded', mode: 'incremental', seen: 0 });
    // A new message and an edit of an old one: only the new ts is above the checkpoint.
    chat.slack.messages.C_GEN!.push({
      ts: ts('2026-09-16T09:00:00Z'),
      user: 'U_GRACE',
      text: "We're going with Postgres, decided.",
    });
    const third = await sync(conn.body.id);
    expect(third.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 1,
      ingested: 1,
    });
    const after = await episodesOf(conn.body.recorder);
    expect(after.find((e) => e.messageId === ts('2026-09-16T09:00:00Z'))?.text).toBe(
      "Grace Hopper: We're going with Postgres, decided.",
    );

    // Slack's failures are HTTP 200 with `ok: false`: each is named with its remedy.
    chat.slack.nextError = { method: 'conversations.history', error: 'missing_scope' };
    const scoped = await sync(conn.body.id);
    expect(scoped.body.summary.status).toBe('failed');
    expect(scoped.body.summary.error).toMatch(/needs a scope/);
    chat.slack.tokens.clear();
    const revoked = await sync(conn.body.id);
    expect(revoked.body.summary.status).toBe('failed');
    expect(revoked.body.summary.error).toMatch(/rejected \(invalid_auth\) — reconnect it/);
  }, 60_000);

  it('telegram: a feed — updates are acknowledged, a full run reads only new and marks nothing gone', async () => {
    const conn = await connect({
      packId: 'chat_memory',
      sourceId: 'telegram',
      vertical: 'chat',
      label: 'Telegram',
      config: { chats: ['-1001234567890'] },
      credential: chat.telegram.token,
    });
    expect(conn.status).toBe(201);
    const first = await sync(conn.body.id);
    // The third update is another chat, filtered out by `chats`.
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 2,
      ingested: 2,
      gone: 0,
      failed: 0,
    });
    const eps = await episodesOf(conn.body.recorder);
    expect(eps.map((e) => e.text)).toEqual([
      'Grace Hopper: Ship on Friday?',
      'Acme News: Release 2.3 is out.\n\n[attachment: photo]',
    ]);
    expect(eps[0]!.conversationId).toBe('tg:-1001234567890');

    // The offset was acknowledged: the same updates are gone for good, a new one arrives.
    chat.telegram.updates.push({
      update_id: 44,
      message: {
        message_id: 5,
        chat: { id: -1001234567890, type: 'supergroup', title: 'Acme Team' },
        from: { id: 8, first_name: 'Linus', last_name: 'Berg' },
        date: Math.floor(Date.parse('2026-09-16T08:00:00Z') / 1000),
        text: 'Blocked on the cert renewal.',
      },
    });
    // A FULL run on a feed is still incremental — nothing unseen is "gone", it is merely past.
    const second = await sync(conn.body.id, true);
    expect(second.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 1,
      new: 1,
      ingested: 1,
      gone: 0,
      closed: 0,
    });
    const catalogue = await items(conn.body.id);
    expect(catalogue.body.items).toHaveLength(3);
    expect(catalogue.body.items.every((i: { state: string }) => i.state === 'indexed')).toBe(true);
    expect(
      catalogue.body.items.find(
        (i: { title: string }) => i.title === 'Blocked on the cert renewal.',
      ),
    ).toMatchObject({ originUri: 'https://t.me/c/1234567890/5' });

    // A webhook on the bot: getUpdates answers 409 and the remedy is named.
    chat.telegram.webhookSet = true;
    const conflicted = await sync(conn.body.id);
    expect(conflicted.body.summary.status).toBe('failed');
    expect(conflicted.body.summary.error).toMatch(/deleteWebhook/);
    chat.telegram.webhookSet = false;

    // A wrong token is named without leaking it.
    const wrong = await connect({
      packId: 'chat_memory',
      sourceId: 'telegram',
      vertical: 'chat',
      config: {},
      credential: '999999:WRONG-token',
    });
    const refused = await sync(wrong.body.id);
    expect(refused.body.summary.status).toBe('failed');
    expect(refused.body.summary.error).toMatch(/token was rejected \(401\)/);
    expect(refused.body.summary.error).not.toContain('WRONG-token');
  }, 60_000);
});

function seedSlack(chat: FakeChat): void {
  const s = chat.slack;
  s.users = {
    U_GRACE: { name: 'grace', real_name: 'Grace Hopper' },
    U_LINUS: { name: 'linus', real_name: 'Linus Berg' },
  };
  s.channels = [
    { id: 'C_GEN', name: 'general', is_member: true },
    { id: 'C_OPS', name: 'ops', is_member: true, is_private: true },
    { id: 'C_RANDOM', name: 'random', is_member: false },
  ];
  s.messages = {
    C_GEN: [
      {
        ts: ts('2026-09-15T10:00:00Z'),
        user: 'U_GRACE',
        text: 'Can someone review the checkout PR in <#C_DEPLOYS|deploys>? <https://acme.test/spec|spec>',
      },
      {
        ts: ts('2026-09-15T10:05:00Z'),
        thread_ts: ts('2026-09-15T10:00:00Z'),
        user: 'U_LINUS',
        text: 'On it, <@U_GRACE>.',
        files: [{ name: 'review-notes.txt' }],
      },
      {
        ts: ts('2026-09-15T11:00:00Z'),
        user: 'U_LINUS',
        subtype: 'channel_join',
        text: 'has joined',
      },
      {
        ts: ts('2026-09-15T12:00:00Z'),
        user: 'U_GRACE',
        text: 'Blocked on the API key for staging.',
      },
      // Before `since`: never listed.
      { ts: ts('2026-08-01T09:00:00Z'), user: 'U_GRACE', text: 'stale' },
    ],
    C_OPS: [
      { ts: ts('2026-09-15T13:00:00Z'), user: 'U_LINUS', text: 'Deploy window moves to 18:00.' },
    ],
    C_RANDOM: [{ ts: ts('2026-09-15T14:00:00Z'), user: 'U_GRACE', text: 'never read' }],
  };
}

function seedTelegram(chat: FakeChat): void {
  const group = { id: -1001234567890, type: 'supergroup', title: 'Acme Team' };
  chat.telegram.updates = [
    {
      update_id: 41,
      message: {
        message_id: 2,
        chat: group,
        from: { id: 7, first_name: 'Grace', last_name: 'Hopper' },
        date: Math.floor(Date.parse('2026-09-15T10:00:00Z') / 1000),
        text: 'Ship on Friday?',
      },
    },
    {
      update_id: 42,
      channel_post: {
        message_id: 3,
        chat: group,
        sender_chat: { id: -100999, type: 'channel', title: 'Acme News' },
        date: Math.floor(Date.parse('2026-09-15T11:00:00Z') / 1000),
        caption: 'Release 2.3 is out.',
        photo: [{ file_id: 'p1' }],
      },
    },
    {
      update_id: 43,
      message: {
        message_id: 9,
        chat: { id: -1009999999999, type: 'supergroup', title: 'Other Team' },
        from: { id: 9, first_name: 'Someone' },
        date: Math.floor(Date.parse('2026-09-15T12:00:00Z') / 1000),
        text: 'not ours',
      },
    },
  ];
}
