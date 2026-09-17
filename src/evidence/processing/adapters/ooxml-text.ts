import { readZipParts } from './zip-reader';

/**
 * Text extraction from the three OOXML containers, by structure rather
 * than by parser: an XML parser would be a dependency AND an XXE surface,
 * and the text of a document lives in a handful of element names —
 * `w:t` runs inside `w:p` paragraphs (Word), `t` inside `si` shared
 * strings and `c`/`v` cells inside `row`s (Excel), `a:t` runs inside
 * `a:p` paragraphs per slide (PowerPoint). Everything here is a scan for
 * those names with the entities decoded; markup that is not text
 * (formatting, relationships, media) never becomes output.
 *
 * Deterministic: the same bytes always produce the same string. Layout
 * is preserved to the degree the pack pipeline can use: one line per
 * paragraph / row, tabs between cells, `[sheet: …]` and `[slide i of n]`
 * markers (the PDF adapter's page-marker precedent) so a fact can name
 * where in the document it came from.
 */

export interface OoxmlLimits {
  /** Inflated cap per part. */
  maxPartBytes: number;
  /** Most slides / sheets read. */
  maxSections?: number | undefined;
}

const DEFAULT_MAX_SECTIONS = 500;

// ── Word ──────────────────────────────────────────────────────────────

export function docxText(zip: Buffer, limits: OoxmlLimits): string {
  const parts = readZipParts(zip, {
    select: (n) => n === 'word/document.xml',
    maxPartBytes: limits.maxPartBytes,
  });
  const xml = parts.get('word/document.xml');
  if (!xml) throw new Error('docx carries no word/document.xml part');
  return wordBodyText(xml.toString('utf8'));
}

/**
 * Paragraph → line; w:tab → tab; w:br → newline. A table is rendered
 * first — one line per row, cells tab-separated, a cell's paragraphs
 * joined by a space — and stands in for its paragraphs by a placeholder
 * so it lands in document order without being split by the paragraph
 * pass (each cell holds its own `w:p`).
 */
function wordBodyText(xml: string): string {
  const tables: string[][] = [];
  const flat = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows: string[] = [];
    for (const tr of tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const cells = [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) =>
        wordParagraphs(tc[0]).join(' '),
      );
      const line = cells.join('\t').trimEnd();
      if (line.trim().length > 0) rows.push(line);
    }
    tables.push(rows);
    return `<w:p><w:t>${TABLE_MARK}${String(tables.length - 1)}</w:t></w:p>`;
  });
  const lines: string[] = [];
  for (const line of wordParagraphs(flat)) {
    if (line.startsWith(TABLE_MARK)) lines.push(...(tables[Number(line.slice(1))] ?? []));
    else lines.push(line);
  }
  return lines.join('\n');
}

/** Control character no document text contains — the table placeholder. */
const TABLE_MARK = '\u0001';

function wordParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const line = runsOf(
      para,
      /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g,
      {
        tab: /^<w:tab/,
        newline: /^<w:br|^<w:cr/,
      },
    );
    if (line.trim().length > 0) out.push(line.trimEnd());
  }
  return out;
}

// ── Excel ─────────────────────────────────────────────────────────────

export function xlsxText(zip: Buffer, limits: OoxmlLimits): string {
  const maxSections = limits.maxSections ?? DEFAULT_MAX_SECTIONS;
  const parts = readZipParts(zip, {
    select: (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
    maxPartBytes: limits.maxPartBytes,
  });
  const shared = sharedStrings(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const sheets = sheetOrder(
    parts.get('xl/workbook.xml')?.toString('utf8') ?? '',
    parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '',
    [...parts.keys()].filter((n) => n.startsWith('xl/worksheets/')),
  ).slice(0, maxSections);
  if (sheets.length === 0) throw new Error('xlsx carries no worksheet parts');
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = parts.get(sheet.part)?.toString('utf8');
    if (!xml) continue;
    out.push(`[sheet: ${sheet.name}]`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        cells.push(cellText(cell[1] ?? '', cell[2] ?? '', shared));
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim().length > 0) out.push(line);
    }
  }
  return out.join('\n');
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(runsOf(si[1] ?? '', /<t(?:\s[^>]*)?>([^<]*)<\/t>/g, {}));
  }
  return out;
}

function cellText(attrs: string, inner: string, shared: string[]): string {
  const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
  if (type === 'inlineStr') return runsOf(inner, /<t(?:\s[^>]*)?>([^<]*)<\/t>/g, {});
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  if (v === undefined) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  return decodeEntities(v);
}

/** Workbook order with sheet names; falls back to part-number order. */
function sheetOrder(
  workbook: string,
  rels: string,
  sheetParts: string[],
): Array<{ name: string; part: string }> {
  const relTarget = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(rel[1] ?? '')?.[1];
    const target = /\bTarget="([^"]*)"/.exec(rel[1] ?? '')?.[1];
    if (id && target) relTarget.set(id, normaliseTarget(target));
  }
  const ordered: Array<{ name: string; part: string }> = [];
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = sheet[1] ?? '';
    const name = decodeEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const part = relTarget.get(rid);
    if (part && sheetParts.includes(part)) ordered.push({ name: name || part, part });
  }
  if (ordered.length > 0) return ordered;
  return sheetParts
    .sort((a, b) => partNumber(a) - partNumber(b))
    .map((part) => ({ name: part.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), part }));
}

function normaliseTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target}`;
}

// ── PowerPoint ────────────────────────────────────────────────────────

export function pptxText(zip: Buffer, limits: OoxmlLimits): string {
  const maxSections = limits.maxSections ?? DEFAULT_MAX_SECTIONS;
  const parts = readZipParts(zip, {
    select: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n),
    maxPartBytes: limits.maxPartBytes,
  });
  const slides = [...parts.keys()]
    .sort((a, b) => partNumber(a) - partNumber(b))
    .slice(0, maxSections);
  if (slides.length === 0) throw new Error('pptx carries no slide parts');
  const out: string[] = [];
  slides.forEach((part, i) => {
    out.push(`[slide ${String(i + 1)} of ${String(slides.length)}]`);
    const xml = parts.get(part)?.toString('utf8') ?? '';
    for (const para of xml.split(/<\/a:p>/)) {
      const line = runsOf(
        para,
        /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/>|<a:br>[\s\S]*?<\/a:br>/g,
        {
          newline: /^<a:br/,
        },
      );
      if (line.trim().length > 0) out.push(line.trimEnd());
    }
  });
  return out.join('\n');
}

// ── shared ────────────────────────────────────────────────────────────

/**
 * Concatenate the captured text runs of `re` in order; matches without a
 * capture are separators classified by the `tab` / `newline` patterns.
 */
function runsOf(
  xml: string,
  re: RegExp,
  seps: { tab?: RegExp | undefined; newline?: RegExp | undefined },
): string {
  let out = '';
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) {
      out += decodeEntities(m[1]);
    } else if (seps.newline?.test(m[0])) {
      out += '\n';
    } else if (seps.tab?.test(m[0])) {
      out += '\t';
    }
  }
  return out;
}

function partNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return safeCodePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith('#')) return safeCodePoint(parseInt(body.slice(1), 10), whole);
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(cp: number, whole: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return whole;
  }
}
