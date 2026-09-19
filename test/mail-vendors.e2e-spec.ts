/**
 * Mail as memory, end to end on a REAL SurrealDB (W4.6), against the
 * fake mail servers:
 *  - Gmail: the Google consent asks for gmail.readonly; a full sync
 *    lists the messages after `since`, fetches each raw and lands it as
 *    ONE TURN of its thread through the mention door (episodes:
 *    conversationId = the Gmail thread, the sender as the speaker,
 *    quoted replies stripped, attachments named); an incremental run
 *    lists from the checkpoint's walk time, takes the new message and
 *    marks the one the history feed says was deleted gone; the
 *    attachments entry catalogues the admitted attachments and hands
 *    their bytes to the evidence plane;
 *  - IMAP: a plain socket to the loopback fake under the double opt-in
 *    (and refused without it), LOGIN with the app password, EXAMINE +
 *    UID SEARCH SINCE + one UID FETCH for the headers, the RFC 5092
 *    origin as the locator, the References root as the conversation;
 *    an incremental run fetches only above the last UID; a refused
 *    login is named without the password.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { MAIL_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { rfc822, startFakeMail, type FakeMail } from './fixtures/fake-mail';

const COMPANY = 'co_mail_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_GMAIL',
  'SOURCE_KIND_IMAP',
  'SOURCE_OAUTH_GOOGLE_CLIENT_ID',
  'SOURCE_OAUTH_GOOGLE_CLIENT_SECRET',
  'SOURCE_OAUTH_GOOGLE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'EVIDENCE_SUBSTRATE_ENABLED',
  'EVIDENCE_QUARANTINE',
  'EVIDENCE_FS_ROOT',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

interface Episode {
  conversationId: string;
  messageId: string;
  text: string;
  occurredAt: string;
  source: { recorder?: string };
}

describe('mail vendors: gmail / imap (e2e)', () => {
  let f: AppFixture;
  let mail: FakeMail;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    mail = await startFakeMail();
    fsRoot = await mkdtemp(join(tmpdir(), 'mail-evidence-'));
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_GMAIL: '1',
      SOURCE_KIND_IMAP: '1',
      SOURCE_OAUTH_GOOGLE_CLIENT_ID: 'g-client',
      SOURCE_OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      SOURCE_OAUTH_GOOGLE_BASE_URL: mail.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      EPISODE_SUBSTRATE_ENABLED: '1',
      INGEST_EPISODE_ONLY: '1',
      EVIDENCE_SUBSTRATE_ENABLED: '1',
      EVIDENCE_QUARANTINE: '1',
      EVIDENCE_FS_ROOT: fsRoot,
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seedGmail(mail);
    seedImap(mail);
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: MAIL_MEMORY_PACK, acceptSources: true, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await mail.close();
    await rm(fsRoot, { recursive: true, force: true });
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
  const episodesOf = (recorder: string) =>
    rows<Episode>(
      `SELECT conversationId, messageId, text, occurredAt, source FROM episode WHERE source.recorder = $recorder ORDER BY occurredAt ASC`,
      { recorder },
    );
  const items = (id: string) =>
    f.http.get(`/v1/admin/source-connections/${id}/items?limit=50`).set(auth());
  async function consent(connector: string) {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'google', connector });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    const cb = await f.http.get(`${back.pathname}${back.search}`);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find(
      (g: { provider: string; status: string }) => g.provider === 'google' && g.status === 'active',
    );
    return { cb, grant, authorize };
  }

  it('gmail: consent asks for gmail.readonly; a full sync lands every message as one turn of its thread', async () => {
    const { cb, grant, authorize } = await consent('gmail');
    expect(authorize.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(cb.text).toContain('Connected mike@example.test (google)');
    expect(grant).toMatchObject({ account: 'mike@example.test', refreshable: true });

    const conn = await connect({
      packId: 'mail_memory',
      sourceId: 'gmail',
      vertical: 'mail',
      label: 'Gmail',
      config: { since: '2026-09-01', labelIds: ['INBOX'] },
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });
    // The listing carried the operator's `since` and the label; the fetch was raw.
    const list = mail.calls.find((c) => c.path.startsWith('/gmail/v1/users/me/messages?'))!;
    const listed = new URL(list.path, mail.base);
    expect(listed.searchParams.get('q')).toBe(
      `after:${String(Math.floor(Date.parse('2026-09-01') / 1000))}`,
    );
    expect(listed.searchParams.getAll('labelIds')).toEqual(['INBOX']);
    expect(mail.calls.some((c) => /\/messages\/g1\?format=raw$/.test(c.path))).toBe(true);

    const eps = await episodesOf(conn.body.recorder);
    expect(eps).toHaveLength(3);
    const thread = eps.filter((e) => e.conversationId === 'thread-1');
    expect(thread).toHaveLength(2);
    expect(thread[0]!.messageId).toBe('m1@acme.test');
    expect(new Date(String(thread[0]!.occurredAt)).toISOString()).toBe('2026-09-15T07:00:00.000Z');
    expect(thread[0]!.text).toBe(
      'Anna Ivanova: Subject: Contract for the Q4 batch\n\nHi Mike,\n\nCould you send the signed contract by Friday?\n\n[attachment: term-sheet.pdf]\n[attachment: setup.exe]',
    );
    // The reply: subject dropped, the quoted block and the signature gone.
    expect(thread[1]).toMatchObject({ messageId: 'm2@example.test' });
    expect(thread[1]!.text).toBe('mike: Sure, Monday at the latest.');
    const other = eps.find((e) => e.conversationId === 'thread-2')!;
    expect(other.text).toContain('Bob Lee: Subject: Invoice 4471');
    // Every catalogue row names its thread as the origin and the message id as the revision.
    const catalogue = await items(conn.body.id);
    expect(catalogue.body.items.map((i: { revision: string }) => i.revision).sort()).toEqual([
      'id:g1',
      'id:g2',
      'id:g3',
    ]);
    // The row links to the episode its turn was captured as.
    expect(
      catalogue.body.items.every(
        (i: { episodeId: string | null }) => typeof i.episodeId === 'string',
      ),
    ).toBe(true);
    // Opened, the row shows the turn it became (speaker, thread, text) and no document.
    const g1 = catalogue.body.items.find((i: { externalId: string }) => i.externalId === 'g1');
    const opened = await f.http
      .get(`/v1/admin/source-connections/${conn.body.id}/items/${encodeURIComponent(g1.id)}`)
      .set(auth());
    expect(opened.status).toBe(200);
    expect(opened.body.documents).toEqual([]);
    expect(opened.body.episode).toMatchObject({
      id: g1.episodeId,
      conversationId: 'thread-1',
      messageId: 'm1@acme.test',
    });
    expect(opened.body.episode.text).toContain('Anna Ivanova: Subject: Contract for the Q4 batch');
    expect(
      catalogue.body.items.find((i: { externalId: string }) => i.externalId === 'g1'),
    ).toMatchObject({
      title: 'Contract for the Q4 batch',
      originUri: expect.stringContaining('#all/thread-1'),
    });

    // Nothing new: the incremental run re-lists the overlap window and ingests nothing.
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      ingested: 0,
      gone: 0,
    });
    // A new message arrives, an old one is deleted: incremental takes the one, the history feed the other.
    mail.google.messages.set('g4', {
      id: 'g4',
      threadId: 'thread-1',
      internalDate: Date.now(),
      labelIds: ['INBOX'],
      raw: rfc822({
        from: '"Anna Ivanova" <anna@acme.test>',
        subject: 'Re: Contract for the Q4 batch',
        date: new Date().toUTCString(),
        messageId: 'm4@acme.test',
        inReplyTo: 'm2@example.test',
        references: ['m1@acme.test', 'm2@example.test'],
        body: 'Received, thank you.\n\n> Sure, Monday at the latest.',
      }),
    });
    mail.google.messages.delete('g3');
    mail.google.deleted.push({ id: 'g3', historyId: ++mail.google.historyId });
    const third = await sync(conn.body.id);
    expect(third.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      new: 1,
      ingested: 1,
      gone: 1,
      failed: 0,
    });
    const after = await episodesOf(conn.body.recorder);
    expect(after.find((e) => e.messageId === 'm4@acme.test')?.text).toBe(
      'Anna Ivanova: Received, thank you.',
    );
    const gone = await items(conn.body.id);
    expect(
      gone.body.items.find((i: { externalId: string }) => i.externalId === 'g3'),
    ).toMatchObject({ state: 'gone' });
    // The history feed was asked from the checkpoint's id; a too-old id is logged, not fatal.
    expect(mail.calls.some((c) => /\/history\?startHistoryId=\d+/.test(c.path))).toBe(true);
    mail.google.historyFloor = mail.google.historyId + 100;
    const fourth = await sync(conn.body.id);
    expect(fourth.body.summary).toMatchObject({ status: 'succeeded', gone: 0, failed: 0 });
    mail.google.historyFloor = 1;
  }, 60_000);

  it('gmail attachments: the admitted attachments are catalogued and their bytes handed to the evidence plane', async () => {
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'google');
    const conn = await connect({
      packId: 'mail_memory',
      sourceId: 'gmail_attachments',
      vertical: 'mail',
      config: { since: '2026-09-01' },
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    const run = await sync(conn.body.id);
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 1, fetched: 1, failed: 0 });
    const list = mail.calls
      .filter((c) => c.path.startsWith('/gmail/v1/users/me/messages?'))
      .at(-1)!;
    expect(new URL(list.path, mail.base).searchParams.get('q')).toContain('has:attachment');
    const catalogue = await items(conn.body.id);
    expect(catalogue.body.items).toHaveLength(1);
    expect(catalogue.body.items[0]).toMatchObject({
      externalId: 'g1#1',
      title: 'term-sheet.pdf',
      mediaType: 'application/pdf',
      state: 'indexed',
    });
    expect(catalogue.body.items[0].assetId).toBeTruthy();
    expect(mail.calls.some((c) => /\/messages\/g1\/attachments\/att_1$/.test(c.path))).toBe(true);
  }, 60_000);

  it('imap: a plain socket needs the double opt-in; with it, headers in one fetch, the thread from References, only above the last UID next time', async () => {
    const refused = await connect({
      packId: 'mail_memory',
      sourceId: 'imap',
      vertical: 'mail',
      config: { host: mail.imapHost, port: mail.imapPort, tls: false, user: mail.imap.user },
      credential: mail.imap.password,
    });
    expect(refused.status).toBe(201);
    const denied = await sync(refused.body.id);
    expect(denied.body.summary.status).toBe('failed');
    expect(denied.body.summary.error).toMatch(/private opt-in/);
    expect(denied.body.summary.error).not.toContain(mail.imap.password);

    const conn = await connect({
      packId: 'mail_memory',
      sourceId: 'imap',
      vertical: 'mail',
      label: 'IMAP',
      config: {
        host: mail.imapHost,
        port: mail.imapPort,
        tls: false,
        user: mail.imap.user,
        mailboxes: ['INBOX', 'Clients'],
        since: '2026-09-01',
        allowPrivate: true,
      },
      credential: mail.imap.password,
    });
    expect(conn.status).toBe(201);
    mail.imapCommands.length = 0;
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });
    const cmds = mail.imapCommands.map((c) => c.replace(/^\S+ /, ''));
    expect(cmds[0]).toBe('LOGIN "mike@example.test" <redacted>');
    expect(cmds).toContain('EXAMINE "INBOX"');
    expect(cmds).toContain('UID SEARCH SINCE 1-Sep-2026');
    expect(cmds).toContain(
      'UID FETCH 1:2 (UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])',
    );
    expect(cmds).toContain('EXAMINE "Clients"');
    expect(cmds.at(-1)).toBe('LOGOUT');
    expect(cmds.some((c) => c.includes(mail.imap.password))).toBe(false);

    const eps = await episodesOf(conn.body.recorder);
    expect(eps).toHaveLength(3);
    const thread = eps.filter((e) => e.conversationId === 'i1@acme.test');
    expect(thread.map((e) => e.messageId)).toEqual(['i1@acme.test', 'i2@example.test']);
    expect(thread[1]!.text).toBe('mike: Approved — go with the two-year term.');
    expect(eps.find((e) => e.conversationId === 'i3@partner.test')?.text).toContain(
      'Subject: Delivery schedule',
    );
    const catalogue = await items(conn.body.id);
    const row = catalogue.body.items.find(
      (i: { externalId: string }) => i.externalId === 'i3@partner.test',
    );
    expect(row).toMatchObject({
      title: 'Delivery schedule',
      revision: 'm:i3@partner.test',
      originUri: `imap://mike%40example.test@${mail.imapHost}/Clients;UIDVALIDITY=7/;UID=1`,
    });

    // A new message in INBOX: the incremental run asks for UIDs above the checkpoint's only.
    mail.imap.mailboxes.get('INBOX')!.messages.push({
      uid: 3,
      internalDate: '18-Sep-2026 08:00:00 +0000',
      raw: rfc822({
        from: '"Anna Ivanova" <anna@acme.test>',
        subject: 'Re: Term sheet',
        date: 'Fri, 18 Sep 2026 08:00:00 +0000',
        messageId: 'i4@acme.test',
        inReplyTo: 'i2@example.test',
        references: ['i1@acme.test', 'i2@example.test'],
        body: 'Signed copy attached tomorrow.',
      }),
    });
    mail.imapCommands.length = 0;
    const second = await sync(conn.body.id);
    expect(second.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 1,
      new: 1,
      ingested: 1,
    });
    const incr = mail.imapCommands.map((c) => c.replace(/^\S+ /, ''));
    expect(incr).toContain('UID SEARCH UID 3:*');
    expect(incr).toContain('UID SEARCH UID 2:*');
    expect(incr.some((c) => c.startsWith('UID SEARCH SINCE'))).toBe(false);
    const after = await episodesOf(conn.body.recorder);
    expect(after.find((e) => e.messageId === 'i4@acme.test')).toMatchObject({
      conversationId: 'i1@acme.test',
      text: 'Anna Ivanova: Signed copy attached tomorrow.',
    });

    // The password rotated at the provider: the run fails by name, the password stays out of the error.
    mail.imap.password = 'rotated';
    const failed = await sync(conn.body.id);
    expect(failed.body.summary.status).toBe('failed');
    expect(failed.body.summary.error).toMatch(/login was refused/);
    expect(failed.body.summary.error).not.toContain('app-pass-w0rd');
    mail.imap.password = 'app-pass-w0rd';
  }, 60_000);
});

function seedGmail(mail: FakeMail): void {
  const g = mail.google;
  g.messages.set('g1', {
    id: 'g1',
    threadId: 'thread-1',
    internalDate: Date.parse('2026-09-15T07:00:00Z'),
    labelIds: ['INBOX'],
    attachments: [
      {
        partId: '1',
        filename: 'term-sheet.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 fake term sheet'),
      },
      {
        partId: '2',
        filename: 'setup.exe',
        mimeType: 'application/octet-stream',
        data: Buffer.from('MZ'),
      },
    ],
    raw: rfc822({
      from: '"Anna Ivanova" <anna@acme.test>',
      subject: 'Contract for the Q4 batch',
      date: 'Tue, 15 Sep 2026 10:00:00 +0300',
      messageId: 'm1@acme.test',
      body: 'Hi Mike,\n\nCould you send the signed contract by Friday?\n\n-- \nAnna\nACME',
      attachments: [
        {
          filename: 'term-sheet.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('%PDF-1.4 fake term sheet'),
        },
        { filename: 'setup.exe', mimeType: 'application/octet-stream', data: Buffer.from('MZ') },
      ],
    }),
  });
  g.messages.set('g2', {
    id: 'g2',
    threadId: 'thread-1',
    internalDate: Date.parse('2026-09-15T11:00:00Z'),
    labelIds: ['INBOX', 'SENT'],
    raw: rfc822({
      from: 'mike@example.test',
      to: 'anna@acme.test',
      subject: 'Re: Contract for the Q4 batch',
      date: 'Tue, 15 Sep 2026 11:00:00 +0000',
      messageId: 'm2@example.test',
      inReplyTo: 'm1@acme.test',
      references: ['m1@acme.test'],
      body: 'Sure, Monday at the latest.\n\nOn Tue, 15 Sep 2026 at 10:00, Anna Ivanova <anna@acme.test> wrote:\n> Could you send the signed contract by Friday?\n\n-- \nMike',
    }),
  });
  g.messages.set('g3', {
    id: 'g3',
    threadId: 'thread-2',
    internalDate: Date.parse('2026-09-16T09:00:00Z'),
    labelIds: ['INBOX'],
    raw: rfc822({
      from: 'Bob Lee <bob@partner.test>',
      subject: 'Invoice 4471',
      date: 'Wed, 16 Sep 2026 09:00:00 +0000',
      messageId: 'm3@partner.test',
      body: 'Invoice 4471 is due on 30 September.',
    }),
  });
  // Before `since`: never listed.
  g.messages.set('g0', {
    id: 'g0',
    threadId: 'thread-0',
    internalDate: Date.parse('2026-08-01T09:00:00Z'),
    labelIds: ['INBOX'],
    raw: rfc822({
      from: 'old@partner.test',
      subject: 'Old news',
      date: 'Sat, 1 Aug 2026 09:00:00 +0000',
      messageId: 'm0@partner.test',
      body: 'stale',
    }),
  });
}

function seedImap(mail: FakeMail): void {
  mail.imap.mailboxes.set('INBOX', {
    uidValidity: 1725,
    messages: [
      {
        uid: 1,
        internalDate: '15-Sep-2026 10:00:00 +0300',
        raw: rfc822({
          from: '"Anna Ivanova" <anna@acme.test>',
          subject: 'Term sheet',
          date: 'Tue, 15 Sep 2026 10:00:00 +0300',
          messageId: 'i1@acme.test',
          body: 'Please find the term sheet attached; the two-year option is on page 3.',
        }),
      },
      {
        uid: 2,
        internalDate: '15-Sep-2026 12:00:00 +0000',
        raw: rfc822({
          from: 'mike@example.test',
          subject: 'Re: Term sheet',
          date: 'Tue, 15 Sep 2026 12:00:00 +0000',
          messageId: 'i2@example.test',
          inReplyTo: 'i1@acme.test',
          references: ['i1@acme.test'],
          body: 'Approved — go with the two-year term.\n\n> the two-year option is on page 3.',
        }),
      },
    ],
  });
  mail.imap.mailboxes.set('Clients', {
    uidValidity: 7,
    messages: [
      {
        uid: 1,
        internalDate: '17-Sep-2026 09:15:00 +0000',
        raw: rfc822({
          from: 'Bob Lee <bob@partner.test>',
          subject: 'Delivery schedule',
          date: 'Thu, 17 Sep 2026 09:15:00 +0000',
          messageId: 'i3@partner.test',
          body: 'First batch ships on the 25th.',
        }),
      },
    ],
  });
}
