/**
 * Notion's blocks and page properties reduced to text — the document a
 * page becomes at the document door. Markdown-shaped so headings, lists
 * and code survive as structure; every rich text run is its
 * `plain_text`, links kept in parentheses. Not a Notion renderer: a
 * block type this file does not know contributes its rich text, if any,
 * and nothing else.
 */

export interface RichText {
  plain_text?: string;
  href?: string | null;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

export function richTextOf(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  return (runs as RichText[])
    .map((r) => {
      const text = r.plain_text ?? '';
      return r.href && text && !text.includes(r.href) ? `${text} (${r.href})` : text;
    })
    .join('');
}

type Body = Record<string, unknown> | undefined;
type BlockRenderer = (body: Body, rich: string, numbered: number) => string;

const quoteLines = (rich: string): string =>
  rich
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
const linkish: BlockRenderer = (body) => {
  if (typeof body?.url !== 'string') return '';
  const caption = richTextOf(body.caption);
  return caption ? `${caption} (${body.url})` : body.url;
};
const media: (type: string) => BlockRenderer = (type) => (body) => {
  const caption = richTextOf(body?.caption) || (typeof body?.name === 'string' ? body.name : '');
  return caption ? `[${type}] ${caption}` : '';
};

/** Each block type's own line(s); a type not listed contributes its rich text. */
const BLOCKS: Record<string, BlockRenderer> = {
  heading_1: (_b, rich) => `# ${rich}`,
  heading_2: (_b, rich) => `## ${rich}`,
  heading_3: (_b, rich) => `### ${rich}`,
  bulleted_list_item: (_b, rich) => `- ${rich}`,
  numbered_list_item: (_b, rich, n) => `${n || 1}. ${rich}`,
  to_do: (body, rich) => `${body?.checked ? '[x]' : '[ ]'} ${rich}`,
  quote: (_b, rich) => quoteLines(rich),
  callout: (_b, rich) => rich,
  code: (body, rich) =>
    `\`\`\`${typeof body?.language === 'string' ? body.language : ''}\n${rich}\n\`\`\``,
  equation: (body) => (typeof body?.expression === 'string' ? body.expression : ''),
  divider: () => '---',
  table_row: (body) =>
    (Array.isArray(body?.cells) ? (body.cells as unknown[]) : [])
      .map((c) => richTextOf(c))
      .join(' | '),
  child_page: (body) => (typeof body?.title === 'string' ? `[page] ${body.title}` : ''),
  child_database: (body) => (typeof body?.title === 'string' ? `[database] ${body.title}` : ''),
  bookmark: linkish,
  embed: linkish,
  link_preview: linkish,
  image: media('image'),
  file: media('file'),
  pdf: media('pdf'),
  video: media('video'),
  audio: media('audio'),
};

/** One block's own line(s) — without its children (the caller indents those). */
export function blockText(block: NotionBlock, numbered = 0): string {
  const body = block[block.type] as Body;
  const rich = richTextOf(body?.rich_text);
  const render = BLOCKS[block.type];
  return render ? render(body, rich, numbered) : rich;
}

/** A page's properties as `key: value` lines — a database row's columns; the title property is left to the title. */
export function propertiesText(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object') return [];
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    const p = raw as { type?: string } & Record<string, unknown>;
    if (!p || typeof p.type !== 'string' || p.type === 'title') continue;
    const v = propertyValue(p);
    if (v) lines.push(`${key}: ${v}`);
  }
  return lines;
}

/** The title property's text, whatever the property is called. */
export function titleOf(properties: unknown): string | undefined {
  if (!properties || typeof properties !== 'object') return undefined;
  for (const raw of Object.values(properties as Record<string, unknown>)) {
    const p = raw as { type?: string; title?: unknown };
    if (p?.type === 'title') {
      const t = richTextOf(p.title).trim();
      if (t) return t;
    }
  }
  return undefined;
}

type PropertyRenderer = (v: unknown) => string;
const asString: PropertyRenderer = (v) => (typeof v === 'string' ? v : '');
const names: PropertyRenderer = (v) =>
  Array.isArray(v) ? v.map(nameOf).filter(Boolean).join(', ') : '';
const dateOf: PropertyRenderer = (v) => {
  const d = v as { start?: string; end?: string } | null;
  return d?.start ? (d.end ? `${d.start} → ${d.end}` : d.start) : '';
};
/** A formula's or rollup's inner value, by its own type. */
const inner: PropertyRenderer = (v) => {
  const f = v as ({ type?: string } & Record<string, unknown>) | null;
  const x = f?.[f?.type ?? ''];
  if (Array.isArray(x)) {
    return x
      .map((y) => propertyValue(y as { type?: string } & Record<string, unknown>))
      .filter(Boolean)
      .join(', ');
  }
  if (x && typeof x === 'object') return dateOf(x);
  return x === null || x === undefined ? '' : String(x);
};

const PROPERTIES: Record<string, PropertyRenderer> = {
  rich_text: (v) => richTextOf(v),
  number: (v) => (typeof v === 'number' ? String(v) : ''),
  checkbox: (v) => (v ? 'yes' : 'no'),
  select: nameOf,
  status: nameOf,
  multi_select: names,
  people: names,
  date: dateOf,
  url: asString,
  email: asString,
  phone_number: asString,
  created_time: asString,
  last_edited_time: asString,
  formula: inner,
  rollup: inner,
  created_by: nameOf,
  last_edited_by: nameOf,
  relation: (v) => (Array.isArray(v) ? `${v.length} linked` : ''),
  files: (v) =>
    Array.isArray(v)
      ? v
          .map((f) => (f as { name?: string }).name ?? '')
          .filter(Boolean)
          .join(', ')
      : '',
  unique_id: (v) => {
    const u = v as { prefix?: string | null; number?: number } | null;
    return u?.number !== undefined ? `${u.prefix ? `${u.prefix}-` : ''}${u.number}` : '';
  },
};

function propertyValue(p: { type?: string } & Record<string, unknown>): string {
  const render = PROPERTIES[p.type ?? ''];
  return render ? render(p[p.type ?? '']) : '';
}

function nameOf(v: unknown): string {
  const n = (v as { name?: string } | null)?.name;
  return typeof n === 'string' ? n : '';
}
