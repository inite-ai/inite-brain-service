/**
 * A conservative HTML → text reduction shared by everything that meets
 * HTML on its way to the document door: the `url` connector (pages), the
 * `fs` connector (.html files), the mail adapter (text/html bodies).
 * Structure-only: scripts, styles, head and comments are dropped, block
 * ends become newlines, entities are decoded. Not a browser — an
 * `article`-extraction heuristic is a later, richer path.
 */
export function htmlToText(html: string): { title: string | undefined; body: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<head[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title\s*>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer|blockquote|pre)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: title ? decodeHtmlEntities(title).replace(/\s+/g, ' ').trim() : undefined,
    body: s,
  };
}

/** `&amp;` is decoded last: decoding it first turns `&amp;lt;` into `<`. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n), `&#${n};`))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16), `&#x${h};`))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(cp: number, whole: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return whole;
  }
}
