import { Readable } from 'node:stream';
import { OfficeTextAdapter } from '../src/evidence/processing/adapters/office-text.adapter';
import { MailTextAdapter } from '../src/evidence/processing/adapters/mail-text.adapter';
import {
  docxText,
  pptxText,
  xlsxText,
  decodeEntities,
} from '../src/evidence/processing/adapters/ooxml-text';
import { readZipParts } from '../src/evidence/processing/adapters/zip-reader';
import { mailText, decodeWords } from '../src/evidence/processing/adapters/mail-text';
import type { ProcessorInput } from '../src/evidence/processing/processor-adapter';
import { buildZip, docxBytes, pptxBytes, xlsxBytes } from './fixtures/ooxml';

const LIMITS = { maxPartBytes: 1 << 20 };

function input(bytes: Buffer, mediaType: string): ProcessorInput {
  return {
    asset: {
      id: 'a',
      modality: 'document',
      mediaType,
      availability: 'hot',
      byteLength: bytes.length,
    },
    openStream: () => Promise.resolve(Readable.from([bytes])),
  };
}

describe('zip-reader — bounded, named-parts-only', () => {
  it('inflates only the selected parts, STORE and DEFLATE alike', () => {
    const zip = buildZip(
      [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.bin', data: Buffer.from([1, 2, 3]), deflate: false },
        { name: 'c.txt', data: 'gamma' },
      ],
      { comment: 'trailing comment' },
    );
    const parts = readZipParts(zip, { select: (n) => n !== 'c.txt', maxPartBytes: 1024 });
    expect([...parts.keys()].sort()).toEqual(['a.txt', 'b.bin']);
    expect(parts.get('a.txt')?.toString()).toBe('alpha');
    expect([...(parts.get('b.bin') ?? [])]).toEqual([1, 2, 3]);
  });

  it('refuses a declared bomb, a real bomb, an encrypted part and a directory over the cap', () => {
    const declared = buildZip([{ name: 'x', data: 'small', declaredSize: 10_000 }]);
    expect(() => readZipParts(declared, { select: () => true, maxPartBytes: 1000 })).toThrow(
      /declares 10000 bytes/,
    );
    // A lying declaration that fits, over content that does not: zlib's cap catches it.
    const real = buildZip([{ name: 'y', data: Buffer.alloc(50_000, 0x41), declaredSize: 10 }]);
    expect(() => readZipParts(real, { select: () => true, maxPartBytes: 1000 })).toThrow(
      /failed to inflate/,
    );
    const enc = buildZip([{ name: 'z', data: 'secret', encrypted: true }]);
    expect(() => readZipParts(enc, { select: () => true, maxPartBytes: 1000 })).toThrow(
      /encrypted/,
    );
    const many = buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, data: 'x' })));
    expect(() =>
      readZipParts(many, { select: () => true, maxPartBytes: 1000, maxEntries: 4 }),
    ).toThrow(/cap 4/);
    expect(() =>
      readZipParts(Buffer.from('not a zip at all'), { select: () => true, maxPartBytes: 10 }),
    ).toThrow(/not a ZIP/);
  });
});

describe('ooxml-text', () => {
  it('docx: paragraphs become lines, table cells tabs, entities decode, media is never read', () => {
    const text = docxText(
      docxBytes(['Acme Robotics <2019>', 'CTO: Maria &amp; co', ['name', 'role'], 'Orbit arm']),
      LIMITS,
    );
    expect(text).toBe('Acme Robotics <2019>\nCTO: Maria &amp; co\nname\trole\nOrbit arm');
  });

  it('xlsx: sheets in workbook order with markers, shared strings and numbers, tab-separated', () => {
    const text = xlsxText(
      xlsxBytes([
        {
          name: 'Vendors',
          rows: [
            ['vendor', 'part'],
            ['Nidec', 'motor'],
            ['Maxon', 42],
          ],
        },
        { name: 'Notes & more', rows: [['backup ok']] },
      ]),
      LIMITS,
    );
    expect(text).toBe(
      '[sheet: Vendors]\nvendor\tpart\nNidec\tmotor\nMaxon\t42\n[sheet: Notes & more]\nbackup ok',
    );
  });

  it('xlsx: without a workbook part the sheets fall back to part-number order', () => {
    const zip = buildZip([
      {
        name: 'xl/worksheets/sheet10.xml',
        data: '<worksheet><sheetData><row><c t="inlineStr"><is><t>ten</t></is></c></row></sheetData></worksheet>',
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: '<worksheet><sheetData><row><c><v>2</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect(xlsxText(zip, LIMITS)).toBe('[sheet: sheet2]\n2\n[sheet: sheet10]\nten');
  });

  it('pptx: slides in numeric order with markers, empty paragraphs dropped', () => {
    const text = pptxText(pptxBytes([['Title', 'Sub'], [], ['Last']]), LIMITS);
    expect(text).toBe('[slide 1 of 3]\nTitle\nSub\n[slide 2 of 3]\n[slide 3 of 3]\nLast');
  });

  it('names a container that carries no text part', () => {
    expect(() => docxText(buildZip([{ name: 'other.xml', data: '<x/>' }]), LIMITS)).toThrow(
      /no word\/document.xml/,
    );
    expect(() =>
      pptxText(buildZip([{ name: 'ppt/presentation.xml', data: '<x/>' }]), LIMITS),
    ).toThrow(/no slide parts/);
  });

  it('decodeEntities handles named, decimal and hex forms and leaves the unknown alone', () => {
    expect(decodeEntities('a&amp;b &lt;c&gt; &#65;&#x42; &bogus; &#xFFFFFFFF;')).toBe(
      'a&b <c> AB &bogus; &#xFFFFFFFF;',
    );
  });
});

describe('OfficeTextAdapter', () => {
  const adapter = new OfficeTextAdapter();

  it('accepts the three macro-free OOXML types on the document modality only', () => {
    expect(
      adapter.accepts(
        'document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document; x=1',
      ),
    ).toBe(true);
    expect(
      adapter.accepts(
        'document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe(true);
    expect(
      adapter.accepts(
        'document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe(true);
    expect(adapter.accepts('document', 'application/vnd.ms-word.document.macroenabled.12')).toBe(
      false,
    );
    expect(adapter.accepts('document', 'application/pdf')).toBe(false);
    expect(
      adapter.accepts(
        'image',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(false);
    expect(adapter.configParts()).toEqual(['render=ooxml-lines-v1']);
  });

  it('produces one asset-level text representation per document', async () => {
    const out = await adapter.process(
      input(
        docxBytes(['Hello', 'World']),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    );
    expect(out).toEqual([{ kind: 'text', content: 'Hello\nWorld' }]);
  });

  it('fails a text-free document by name rather than writing an empty representation', async () => {
    await expect(
      adapter.process(
        input(
          docxBytes([]),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ),
    ).rejects.toThrow(/carries no text/);
  });
});

const EML = [
  'From: =?UTF-8?B?TWFyw61hIExpbmQ=?= <maria@acme.example>',
  'To: team@acme.example',
  'Cc: ops@acme.example',
  'Date: Tue, 16 Sep 2026 10:00:00 +0000',
  'Subject: =?utf-8?q?Q3_plan=3A_motors?=',
  ' (draft)',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset="iso-8859-1"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Preferred vendor: Nidec. Caf=E9 at 3.=',
  '',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Preferred vendor: <b>Nidec</b>.</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--outer--',
  '',
].join('\r\n');

describe('mail-text', () => {
  it('renders headers (RFC 2047 decoded, folded), the plain body (QP + charset), and names attachments', () => {
    expect(mailText(Buffer.from(EML, 'latin1'))).toBe(
      [
        'From: María Lind <maria@acme.example>',
        'To: team@acme.example',
        'Cc: ops@acme.example',
        'Date: Tue, 16 Sep 2026 10:00:00 +0000',
        'Subject: Q3 plan: motors (draft)',
        '',
        'Preferred vendor: Nidec. Café at 3.',
        '',
        '[attachment: plan.pdf (application/pdf, 12 bytes)]',
      ].join('\n'),
    );
  });

  it('falls back to the HTML body reduced to text when no text/plain part exists', () => {
    const eml = [
      'Subject: hi',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><h1>Hello</h1><p>Vendor &amp; co</p></body></html>',
    ].join('\r\n');
    expect(mailText(Buffer.from(eml))).toBe('Subject: hi\n\nHello\nVendor & co');
  });

  it('bounds the part walk', () => {
    const parts = Array.from(
      { length: 30 },
      (_, i) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`,
    ).join('');
    const eml = `Subject: many\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}--b--\r\n`;
    expect(mailText(Buffer.from(eml), { maxParts: 3 })).toBe('Subject: many\n\npart 0');
  });

  it('decodeWords handles B and Q words and unknown charsets', () => {
    expect(decodeWords('=?utf-8?B?w6k=?= x =?us-ascii?Q?a_b?=')).toBe('é x a b');
    expect(decodeWords('=?x-nonsense?Q?plain?=')).toBe('plain');
  });

  it('MailTextAdapter accepts message/rfc822 on the document modality and emits one text output', async () => {
    const adapter = new MailTextAdapter();
    expect(adapter.accepts('document', 'message/rfc822')).toBe(true);
    expect(adapter.accepts('document', 'text/plain')).toBe(false);
    expect(adapter.accepts('image', 'message/rfc822')).toBe(false);
    const out = await adapter.process(input(Buffer.from(EML, 'latin1'), 'message/rfc822'));
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toContain('Subject: Q3 plan: motors (draft)');
  });
});
