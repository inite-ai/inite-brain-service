/**
 * The mail connectors' pure parts (W4.6): a message as one turn (the
 * speaker, the stripped body, the subject on a starter only, the
 * thread root from References, attachments named), the MIME parse with
 * attachment bytes, and the IMAP client's grammar — a FETCH answer with
 * a literal and a bracketed section tokenised, sequence sets, dates,
 * the RFC 5092 locator — plus the egress fence a plain socket meets.
 */
import { parseMail } from '../src/evidence/processing/adapters/mail-text';
import {
  imapDate,
  internalDateOf,
  sequenceSet,
  tokenize,
} from '../src/source-plane/connectors/imap-client';
import { locatorOf } from '../src/source-plane/connectors/imap.connector';
import {
  addressesOf,
  bareSubject,
  mailTurnOf,
  stripQuotes,
} from '../src/source-plane/connectors/mail-turn';
import { assertConnectableHost } from '../src/source-plane/connectors/safe-fetch';
import { rfc822 } from './fixtures/fake-mail';

describe('mail-turn: a message as one turn', () => {
  it('a thread starter carries its subject, the sender is the speaker, attachments are named', () => {
    const raw = rfc822({
      from: '"Anna Ivanova" <anna@acme.test>',
      subject: 'Contract for the Q4 batch',
      date: 'Tue, 15 Sep 2026 10:00:00 +0300',
      messageId: 'm1@acme.test',
      body: 'Hi Mike,\n\nCould you send the signed contract by Friday?\n\n-- \nAnna\nACME',
      attachments: [
        {
          filename: 'term-sheet.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('%PDF-1.4 x'),
        },
      ],
    });
    const t = mailTurnOf(Buffer.from(raw, 'utf8'));
    expect(t.turn.speaker).toBe('Anna Ivanova');
    expect(t.messageId).toBe('m1@acme.test');
    expect(t.threadRoot).toBeNull();
    expect(t.turn.at).toBe('2026-09-15T07:00:00.000Z');
    expect(t.turn.text).toBe(
      'Subject: Contract for the Q4 batch\n\nHi Mike,\n\nCould you send the signed contract by Friday?\n\n[attachment: term-sheet.pdf]',
    );
  });

  it('a reply drops the subject, its quoted block and the signature; the thread root is the first Reference', () => {
    const raw = rfc822({
      from: 'mike@example.test',
      subject: 'Re: Contract for the Q4 batch',
      date: 'Tue, 15 Sep 2026 11:00:00 +0000',
      messageId: 'm2@example.test',
      inReplyTo: 'm1@acme.test',
      references: ['m1@acme.test'],
      body: 'Sure, Monday at the latest.\n\nOn Tue, 15 Sep 2026 at 10:00, Anna Ivanova <anna@acme.test> wrote:\n> Could you send the signed contract by Friday?\n>\n> -- Anna',
    });
    const t = mailTurnOf(Buffer.from(raw, 'utf8'));
    expect(t.turn.speaker).toBe('mike');
    expect(t.threadRoot).toBe('m1@acme.test');
    expect(t.turn.text).toBe('Sure, Monday at the latest.');
  });

  it('stripQuotes: `>` lines anywhere, an Outlook header block, a Russian "написал(а):" opener, blank runs', () => {
    expect(
      stripQuotes(
        'Ok.\n\n> old line\nMore.\n\n\n\nFrom: Bob <bob@x.test>\nSent: Monday\nTo: me\nSubject: x\n\nquoted body',
      ),
    ).toBe('Ok.\n\nMore.');
    expect(
      stripQuotes('Договорились.\n\n15.09.2026 10:00, Анна Иванова написал(а):\n> текст'),
    ).toBe('Договорились.');
    expect(stripQuotes('Yes\n\n---------- Forwarded message ---------\nFrom: x\n\nbody')).toBe(
      'Yes',
    );
  });

  it('addressesOf and bareSubject', () => {
    expect(
      addressesOf('"Doe, Jane" <jane@x.test>, bob@y.test, =?utf-8?Q?Ann=C3=A9?= <a@z.test>'),
    ).toEqual([
      { name: 'Doe, Jane', address: 'jane@x.test' },
      { name: null, address: 'bob@y.test' },
      { name: 'Anné', address: 'a@z.test' },
    ]);
    expect(bareSubject('Re: RE: Fwd: Отв: Contract')).toBe('Contract');
  });

  it('parseMail keeps attachment bytes when asked, decoded from base64', () => {
    const raw = rfc822({
      from: 'a@b.test',
      subject: 's',
      date: 'Tue, 15 Sep 2026 10:00:00 +0000',
      messageId: 'x@b.test',
      body: 'hello',
      attachments: [
        { filename: 'invoice.pdf', mimeType: 'application/pdf', data: Buffer.from('PDFBYTES') },
      ],
    });
    const listed = parseMail(Buffer.from(raw, 'utf8'));
    expect(listed.attachments[0]?.bytes).toBeUndefined();
    expect(listed.attachments[0]?.name).toBe('invoice.pdf');
    const kept = parseMail(Buffer.from(raw, 'utf8'), { keepBytes: true });
    expect(kept.attachments[0]?.bytes?.toString('utf8')).toBe('PDFBYTES');
    expect(kept.attachments[0]?.size).toBe(8);
    expect(kept.body.trim()).toBe('hello');
  });
});

describe('imap client: grammar and helpers', () => {
  it('tokenize: a FETCH answer with a bracketed section, a literal, NIL and nested lists', () => {
    const header = Buffer.from('Subject: hi\r\nFrom: a@b.test\r\n\r\n', 'latin1');
    const tokens = tokenize([
      `* 3 FETCH (UID 42 INTERNALDATE "17-Sep-2026 09:15:00 +0300" RFC822.SIZE 1234 FLAGS (\\Seen) ENVELOPE (NIL "hi" (("A" NIL "a" "b.test"))) BODY[HEADER.FIELDS (SUBJECT FROM)] {${String(header.length)}}`,
      header,
      ')',
    ]);
    expect(tokens[0]).toBe('*');
    expect(tokens[1]).toBe('3');
    expect(tokens[2]).toBe('FETCH');
    const list = tokens[3] as unknown[];
    expect(list.slice(0, 4)).toEqual(['UID', '42', 'INTERNALDATE', '17-Sep-2026 09:15:00 +0300']);
    expect(list[6]).toBe('FLAGS');
    expect(list[7]).toEqual(['\\Seen']);
    expect(list[8]).toBe('ENVELOPE');
    expect(list[9]).toEqual([null, 'hi', [['A', null, 'a', 'b.test']]]);
    expect(list[10]).toBe('BODY[HEADER.FIELDS (SUBJECT FROM)]');
    expect(Buffer.isBuffer(list[11])).toBe(true);
    expect((list[11] as Buffer).toString('latin1')).toContain('Subject: hi');
    expect(list.length).toBe(12);
  });

  it('tokenize: quoted strings with escapes and an EXAMINE status code', () => {
    expect(tokenize(['* OK [UIDVALIDITY 1725] UIDs valid'])).toEqual([
      '*',
      'OK',
      '[UIDVALIDITY 1725]',
      'UIDs',
      'valid',
    ]);
    expect(tokenize(['* LIST (\\HasNoChildren) "/" "Sent \\"Items\\""'])).toEqual([
      '*',
      'LIST',
      ['\\HasNoChildren'],
      '/',
      'Sent "Items"',
    ]);
  });

  it('sequenceSet, imapDate, internalDateOf', () => {
    expect(sequenceSet([5, 1, 2, 3, 7, 8, 3])).toBe('1:3,5,7:8');
    expect(sequenceSet([])).toBe('');
    expect(imapDate(new Date('2026-09-01T00:00:00Z'))).toBe('1-Sep-2026');
    expect(internalDateOf('17-Sep-2026 09:15:00 +0300')).toBe('2026-09-17T06:15:00.000Z');
    expect(internalDateOf(null)).toBeNull();
  });

  it('locatorOf reads the RFC 5092 origin back', () => {
    expect(
      locatorOf({
        externalId: 'm1@acme.test',
        originUri:
          'imap://mike%40example.test@imap.example.com/Clients%2F2026;UIDVALIDITY=17/;UID=412',
      }),
    ).toEqual({ mailbox: 'Clients/2026', uid: 412 });
    expect(locatorOf({ externalId: 'x' })).toBeNull();
  });

  it('a plain socket to a private host is refused without the double opt-in', async () => {
    const saved = process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    try {
      await expect(assertConnectableHost('127.0.0.1', { tls: false })).rejects.toThrow(
        /private opt-in/,
      );
      await expect(assertConnectableHost('127.0.0.1', { tls: true })).rejects.toThrow(/non-public/);
      await expect(
        assertConnectableHost('127.0.0.1', { tls: false, allowPrivate: true }),
      ).rejects.toThrow(/private opt-in/);
      process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
      await expect(
        assertConnectableHost('127.0.0.1', { tls: false, allowPrivate: true }),
      ).resolves.toBeUndefined();
      await expect(
        assertConnectableHost('169.254.169.254', { tls: false, allowPrivate: true }),
      ).rejects.toThrow(/link-local/);
    } finally {
      if (saved === undefined) delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
      else process.env.SOURCE_EGRESS_ALLOW_PRIVATE = saved;
    }
  });
});
