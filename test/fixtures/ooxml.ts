import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer + OOXML builders for the office/mail adapter suites:
 * real archives (local headers, central directory, EOCD) with STORE and
 * DEFLATE entries, carrying just the parts the extractor reads. Not a
 * general writer — no ZIP64, no data descriptors.
 */

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Default true. */
  deflate?: boolean;
  /** Lie about the uncompressed size (bomb tests). */
  declaredSize?: number;
  /** Mark encrypted (general-purpose bit 0). */
  encrypted?: boolean;
}

export function buildZip(entries: ZipEntry[], opts: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const deflate = e.deflate ?? true;
    const data = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const method = deflate ? 8 : 0;
    const flags = e.encrypted ? 1 : 0;
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cen = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cen, eocd, comment]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Word document: one `w:p` per paragraph; a string[] paragraph is a table row of cells. */
export function docxBytes(paragraphs: Array<string | string[]>): Buffer {
  const body = paragraphs
    .map((p) =>
      Array.isArray(p)
        ? `<w:tbl><w:tr>${p.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr></w:tbl>`
        : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: xml },
    { name: 'word/media/image1.png', data: Buffer.alloc(64, 1), deflate: false },
  ]);
}

/** A workbook: sheets in order, each a grid of cells (strings via sharedStrings, numbers inline). */
export function xlsxBytes(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>): Buffer {
  const shared: string[] = [];
  const sst = (s: string) => {
    const i = shared.indexOf(s);
    if (i !== -1) return i;
    shared.push(s);
    return shared.length - 1;
  };
  const entries: ZipEntry[] = [];
  const sheetTags: string[] = [];
  const rels: string[] = [];
  sheets.forEach((sh, i) => {
    const n = i + 1;
    const rows = sh.rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) =>
              typeof v === 'number'
                ? `<c r="${String.fromCharCode(65 + ci)}${ri + 1}"><v>${v}</v></c>`
                : `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="s"><v>${sst(v)}</v></c>`,
            )
            .join('')}</row>`,
      )
      .join('');
    entries.push({
      name: `xl/worksheets/sheet${n}.xml`,
      data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    });
    sheetTags.push(`<sheet name="${esc(sh.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    rels.push(`<Relationship Id="rId${n}" Type="x" Target="worksheets/sheet${n}.xml"/>`);
  });
  entries.push(
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns:r="r"><sheets>${sheetTags.join('')}</sheets></workbook>`,
    },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships>${rels.join('')}</Relationships>` },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
    },
  );
  return buildZip(entries);
}

/** A deck: one slide part per entry, paragraphs of `a:t` runs. */
export function pptxBytes(slides: string[][]): Buffer {
  return buildZip(
    slides.map((paras, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `<p:sld xmlns:a="a"><p:cSld>${paras
        .map((p) => `<a:p><a:r><a:t>${esc(p)}</a:t></a:r></a:p>`)
        .join('')}</p:cSld></p:sld>`,
    })),
  );
}
