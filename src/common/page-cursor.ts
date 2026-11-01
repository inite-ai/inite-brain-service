import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset cursors for list routes: `nextCursor` on a page, `cursor`
 * on the next request. A cursor names the last row's sort key, so a page
 * starts strictly after it, and rows inserted or removed meanwhile do not
 * shift the pages the way an offset does. The cursor carries the route
 * kind it belongs to, and a cursor from one list is refused by another
 * (400), not silently read as a different key.
 *
 * Opaque by contract: base64url JSON today, nothing a caller may build or
 * parse. The key fields are the route's own.
 */
export function encodePageCursor(kind: string, key: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ k: kind, ...key })).toString('base64url');
}

/**
 * The key a cursor names, or a 400. `legacy`: the route issued cursors
 * before they carried a kind, and one of those, with every field present
 * and no kind at all, is still accepted.
 */
export function decodePageCursor<F extends string>(
  kind: string,
  raw: string,
  opts: { fields: readonly F[]; legacy?: boolean },
): Record<F, string> {
  const { fields } = opts;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new BadRequestException(`cursor is not a valid ${kind} cursor`);
  }
  const kindOk = parsed.k === kind || (opts.legacy === true && parsed.k === undefined);
  const out = {} as Record<F, string>;
  for (const f of fields) {
    const v = parsed[f];
    if (typeof v !== 'string' || v.length === 0 || !kindOk) {
      throw new BadRequestException(`cursor is not a valid ${kind} cursor`);
    }
    out[f] = v;
  }
  return out;
}
